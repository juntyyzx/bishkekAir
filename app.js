(function () {
  'use strict';

  // ---------- Настройки ----------
  var API = 'https://air-quality-api.open-meteo.com/v1/air-quality';
  var WEATHER_API = 'https://api.open-meteo.com/v1/forecast';
  var TZ = 'Asia/Bishkek';
  var TZ_OFFSET = '+06:00';
  var REFRESH_MS = 10 * 60 * 1000;

  // Главная точка города (из вашей ссылки)
  var CITY = { name: 'Бишкек', lat: 42.87, lon: 74.59 };

  // Точки измерения (координаты приблизительные)
  var POINTS = [
    { name: 'Ак-Орго',  lat: 42.910, lon: 74.600 },
    { name: 'Центр',    lat: 42.875, lon: 74.605 },
    { name: 'Восток-5', lat: 42.865, lon: 74.655 },
    { name: 'Джал',     lat: 42.835, lon: 74.555 },
    { name: 'Асанбай',  lat: 42.815, lon: 74.520 },
    { name: 'Орто-Сай', lat: 42.810, lon: 74.620 }
  ];

  // Шкала окраски районов: белый (0) -> красный (SCALE_MAX и выше)
  var SCALE_MAX = 150;

  // Районы Бишкека (границы берём из OpenStreetMap)
  // ищем по корню названия: подойдут и русские, и кыргызские варианты
  var DISTRICT_STEMS = 'Ленин|Октябрь|Первомай|Свердлов';
  var OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  var CACHE_KEY = 'aq_districts_v1';

  // Уровни US AQI
  var LEVELS = [
    { max: 50,   label: 'Хорошо',                    color: '#3DBE7A', advice: 'Воздух чистый, можно спокойно гулять и заниматься спортом на улице.' },
    { max: 100,  label: 'Умеренно',                  color: '#F2C94C', advice: 'Приемлемо для большинства. Очень чувствительным людям стоит быть внимательнее.' },
    { max: 150,  label: 'Вредно для чувствительных', color: '#F59E42', advice: 'Детям, пожилым и людям с астмой лучше сократить время на улице.' },
    { max: 200,  label: 'Вредно',                    color: '#E5534B', advice: 'Лучше ограничить прогулки и нагрузки на улице, проветривать реже.' },
    { max: 300,  label: 'Очень вредно',              color: '#9B5DE5', advice: 'Оставайтесь в помещении, на улице используйте респиратор.' },
    { max: 9999, label: 'Опасно',                    color: '#B0303A', advice: 'Не выходите без необходимости, закройте окна.' }
  ];

  var state = { updatedAt: null, city: null, points: [], zones: [], history: [], weather: null };
  window.airData = state; // данные доступны для AI

  // Профили: пороги AQI и совет для каждого уровня
  var PROFILES = {
    general: { label: 'Обычный', tiers: [100, 150], texts: [
      'можно гулять и заниматься спортом на улице.',
      'долгие нагрузки на улице лучше сократить.',
      'лучше остаться в помещении, на улице нужен респиратор.' ] },
    child: { label: 'Ребёнок', tiers: [50, 100], texts: [
      'гулять можно без ограничений.',
      'прогулки лучше сделать короче и без бега.',
      'ребёнку лучше остаться в помещении.' ] },
    asthma: { label: 'Астма', tiers: [50, 100], texts: [
      'прогулки в порядке.',
      'выходите ненадолго и берите с собой лекарства.',
      'лучше остаться дома и держать окна закрытыми.' ] },
    sport: { label: 'Спорт', tiers: [50, 100], texts: [
      'тренировка на улице в порядке.',
      'снизьте интенсивность или выберите парк подальше от дорог.',
      'перенесите тренировку в зал.' ] }
  };
  var profileKey = 'general';
  try {
    var savedProfile = localStorage.getItem('aq_profile');
    if (savedProfile && PROFILES[savedProfile]) profileKey = savedProfile;
  } catch (e) { /* пропускаем */ }

  (function initProfile() {
    var sel = document.getElementById('profileSelect');
    sel.value = profileKey;
    sel.addEventListener('change', function () {
      profileKey = sel.value;
      try { localStorage.setItem('aq_profile', profileKey); } catch (e) { /* пропускаем */ }
      renderProfile();
    });
  })();

  var map = null;
  var districtLayer = null;
  var markerLayer = null;
  var districtsGeo = null;
  var districtsError = '';
  var fitted = false;

  // ---------- Помощники ----------
  function $(id) { return document.getElementById(id); }

  function levelOf(aqi) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (aqi <= LEVELS[i].max) return LEVELS[i];
    }
    return LEVELS[LEVELS.length - 1];
  }

  function round(n) { return Math.round(n); }
  function fmt1(n) { return (Math.round(n * 10) / 10).toString().replace('.', ','); }
  function hhmm(isoLocal) { return isoLocal.slice(11, 16); }
  function toArray(json) { return Array.isArray(json) ? json : [json]; }
  function signed(n) { n = round(n); return (n > 0 ? '+' : '') + n + '°'; }

  function check(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // белый -> красный, чем грязнее, тем плотнее
  function zoneStyle(aqi) {
    var t = Math.min(1, Math.max(0, aqi / SCALE_MAX));
    var r = Math.round(255 - 26 * t);
    var g = Math.round(255 - 198 * t);
    var b = Math.round(255 - 202 * t);
    return {
      fillColor: 'rgb(' + r + ',' + g + ',' + b + ')',
      fillOpacity: 0.2 + 0.45 * t,
      color: '#E6EDE8',
      weight: 1.5,
      opacity: 0.75
    };
  }

  // оценка AQI в точке по ближайшим измерениям (обратные расстояния)
  function estimateAt(lat, lon) {
    var sum = 0, wsum = 0;
    for (var i = 0; i < state.points.length; i++) {
      var p = state.points[i];
      var dx = (p.lon - lon) * 0.73;
      var dy = p.lat - lat;
      var d2 = dx * dx + dy * dy;
      if (d2 < 1e-8) return p.aqi;
      var w = 1 / d2;
      sum += w * p.aqi;
      wsum += w;
    }
    return wsum ? sum / wsum : 0;
  }

  // ---------- Загрузка данных ----------
  function loadAll() {
    var all = [CITY].concat(POINTS);
    var lats = all.map(function (p) { return p.lat; }).join(',');
    var lons = all.map(function (p) { return p.lon; }).join(',');

    var urlNow = API + '?latitude=' + lats + '&longitude=' + lons +
      '&current=pm2_5,pm10,us_aqi&timezone=' + encodeURIComponent(TZ);
    var urlHist = API + '?latitude=' + CITY.lat + '&longitude=' + CITY.lon +
      '&hourly=us_aqi,pm2_5&past_days=1&forecast_days=2&timezone=' + encodeURIComponent(TZ);
    var urlWeather = WEATHER_API + '?latitude=' + CITY.lat + '&longitude=' + CITY.lon +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code' +
      '&daily=temperature_2m_max,temperature_2m_min&wind_speed_unit=ms&forecast_days=1' +
      '&timezone=' + encodeURIComponent(TZ);

    // погода не критична: если не загрузилась, остальное всё равно покажем
    var weatherReq = fetch(urlWeather).then(check).catch(function (e) { console.warn('Погода не загрузилась', e); return null; });

    return Promise.all([
      fetch(urlNow).then(check),
      fetch(urlHist).then(check),
      weatherReq
    ]).then(function (res) {
      var now = toArray(res[0]);
      var hist = res[1];
      var w = res[2];

      var c = now[0].current;
      state.city = { name: CITY.name, aqi: c.us_aqi, pm25: c.pm2_5, pm10: c.pm10, time: c.time };
      state.points = POINTS.map(function (p, i) {
        var cur = now[i + 1].current;
        return { name: p.name, lat: p.lat, lon: p.lon, aqi: cur.us_aqi, pm25: cur.pm2_5, pm10: cur.pm10 };
      });
      state.history = lastDay(hist.hourly);
      state.forecast = nextHours(hist.hourly);
      state.best = bestWalk(state.forecast);
      state.updatedAt = c.time;

      if (w && w.current) {
        var info = weatherInfo(w.current.weather_code);
        state.weather = {
          temp: w.current.temperature_2m,
          feels: w.current.apparent_temperature,
          humidity: w.current.relative_humidity_2m,
          wind: w.current.wind_speed_10m,
          code: w.current.weather_code,
          desc: info.desc,
          icon: info.icon,
          min: w.daily && w.daily.temperature_2m_min ? w.daily.temperature_2m_min[0] : null,
          max: w.daily && w.daily.temperature_2m_max ? w.daily.temperature_2m_max[0] : null
        };
      }
    });
  }

  // последние 24 часа до текущего момента
  function lastDay(hourly) {
    var nowMs = Date.now();
    var idx = -1;
    for (var i = 0; i < hourly.time.length; i++) {
      if (new Date(hourly.time[i] + TZ_OFFSET).getTime() <= nowMs) idx = i;
    }
    if (idx < 0) return [];
    var from = Math.max(0, idx - 23);
    var out = [];
    for (var j = from; j <= idx; j++) {
      if (hourly.us_aqi[j] !== null && hourly.us_aqi[j] !== undefined) {
        out.push({ time: hourly.time[j], aqi: hourly.us_aqi[j], pm25: hourly.pm2_5[j] });
      }
    }
    return out;
  }

  // ближайшие 24 часа прогноза (включая текущий час)
  function nextHours(hourly) {
    var nowMs = Date.now();
    var out = [];
    for (var i = 0; i < hourly.time.length && out.length < 24; i++) {
      var ms = new Date(hourly.time[i] + TZ_OFFSET).getTime();
      if (ms > nowMs - 3599000 && hourly.us_aqi[i] !== null && hourly.us_aqi[i] !== undefined) {
        out.push({ time: hourly.time[i], aqi: hourly.us_aqi[i] });
      }
    }
    return out;
  }

  // лучшее двухчасовое окно для прогулки: между 6:00 и 22:00
  function bestWalk(list) {
    var best = null;
    for (var i = 0; i < list.length - 1; i++) {
      var h1 = parseInt(list[i].time.slice(11, 13), 10);
      var h2 = parseInt(list[i + 1].time.slice(11, 13), 10);
      if (h1 < 6 || h1 > 20 || h2 !== h1 + 1) continue;
      var avg = (list[i].aqi + list[i + 1].aqi) / 2;
      if (!best || avg < best.aqi - 0.5) best = { time: list[i].time, aqi: avg };
    }
    return best;
  }

  function pad2(n) { return ('0' + n).slice(-2); }

  function bestText() {
    var b = state.best;
    if (!b || !state.updatedAt) return '';
    var day = b.time.slice(0, 10) === state.updatedAt.slice(0, 10) ? 'сегодня' : 'завтра';
    var h = parseInt(b.time.slice(11, 13), 10);
    return day + ' ' + pad2(h) + ':00–' + pad2(h + 2) + ':00 (AQI ≈ ' + round(b.aqi) + ')';
  }

  function renderBest() {
    var t = bestText();
    $('bestTime').textContent = t ? 'Лучшее время для прогулки: ' + t : '';
  }

  // ---------- Профиль пользователя ----------
  function renderProfile() {
    if (!state.city) return;
    var p = PROFILES[profileKey];
    var t = p.tiers;
    var idx = state.city.aqi <= t[0] ? 0 : (state.city.aqi <= t[1] ? 1 : 2);
    $('aqiYou').textContent = 'Для профиля «' + p.label + '»: ' + p.texts[idx];
  }

  // ---------- Погода: коды и значки ----------
  var ICONS = {
    sun: '<circle cx="24" cy="24" r="8"/><path d="M24 6v6M24 36v6M6 24h6M36 24h6M11.3 11.3l4.2 4.2M32.5 32.5l4.2 4.2M11.3 36.7l4.2-4.2M32.5 15.5l4.2-4.2"/>',
    partly: '<circle cx="17" cy="17" r="6"/><path d="M17 5v3M5 17h3M8.5 8.5l2 2M25.5 8.5l-2 2"/><path d="M16 40h18a7 7 0 0 0 .5-14 10 10 0 0 0-19 2.5A6 6 0 0 0 16 40z"/>',
    cloud: '<path d="M14 36h20a8 8 0 0 0 .6-16A11 11 0 0 0 13 22a7 7 0 0 0 1 14z"/>',
    fog: '<path d="M8 16h32M12 24h28M8 32h32M14 40h22"/>',
    rain: '<path d="M14 28h20a8 8 0 0 0 .6-16A11 11 0 0 0 13 14a7 7 0 0 0 1 14z"/><path d="M16 35l-2 5M25 35l-2 5M34 35l-2 5"/>',
    snow: '<path d="M14 28h20a8 8 0 0 0 .6-16A11 11 0 0 0 13 14a7 7 0 0 0 1 14z"/><circle cx="16" cy="37" r="1.6" fill="currentColor"/><circle cx="25" cy="40" r="1.6" fill="currentColor"/><circle cx="34" cy="37" r="1.6" fill="currentColor"/>',
    storm: '<path d="M14 28h20a8 8 0 0 0 .6-16A11 11 0 0 0 13 14a7 7 0 0 0 1 14z"/><path d="M26 30l-6 9h7l-3 7"/>'
  };

  function weatherInfo(code) {
    if (code === 0) return { desc: 'Ясно', icon: 'sun' };
    if (code === 1) return { desc: 'Малооблачно', icon: 'sun' };
    if (code === 2) return { desc: 'Переменная облачность', icon: 'partly' };
    if (code === 3) return { desc: 'Пасмурно', icon: 'cloud' };
    if (code === 45 || code === 48) return { desc: 'Туман', icon: 'fog' };
    if (code >= 51 && code <= 57) return { desc: 'Морось', icon: 'rain' };
    if (code >= 61 && code <= 67) return { desc: 'Дождь', icon: 'rain' };
    if (code >= 71 && code <= 77) return { desc: 'Снег', icon: 'snow' };
    if (code >= 80 && code <= 82) return { desc: 'Ливень', icon: 'rain' };
    if (code === 85 || code === 86) return { desc: 'Снегопад', icon: 'snow' };
    if (code >= 95) return { desc: 'Гроза', icon: 'storm' };
    return { desc: 'Погода', icon: 'cloud' };
  }

  function renderWeather() {
    var w = state.weather;
    if (!w) {
      $('wDesc').textContent = 'Нет данных о погоде';
      return;
    }
    $('wIcon').innerHTML = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' + ICONS[w.icon] + '</svg>';
    $('wTemp').textContent = signed(w.temp).replace('+', '');
    $('wDesc').textContent = w.desc;
    $('wFeels').textContent = signed(w.feels).replace('+', '');
    $('wWind').textContent = fmt1(w.wind) + ' м/с';
    $('wHum').textContent = round(w.humidity) + '%';
    $('wRange').textContent = (w.min !== null && w.max !== null) ? (round(w.min) + '…' + round(w.max) + '°') : '—';
  }

  // ---------- Границы районов ----------
  function featureName(f) {
    var p = f.properties || {};
    var tags = p.tags || {};
    return p['name:ru'] || tags['name:ru'] || p.name || tags.name || '';
  }

  function cleanDistricts(geo) {
    var re = new RegExp(DISTRICT_STEMS);
    var seen = {};
    var feats = (geo.features || []).filter(function (f) {
      var t = f.geometry && f.geometry.type;
      if (t !== 'Polygon' && t !== 'MultiPolygon') return false;
      var m = re.exec(featureName(f));
      if (!m) return false;
      if (seen[m[0]]) return false;
      seen[m[0]] = true;
      return true;
    });
    if (!feats.length) throw new Error('no districts');
    return { type: 'FeatureCollection', features: feats };
  }

  function fromLocalFile() {
    return fetch('districts.geojson').then(check).then(cleanDistricts);
  }

  function fromCache() {
    return new Promise(function (resolve, reject) {
      try {
        var raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return reject(new Error('no cache'));
        resolve(cleanDistricts(JSON.parse(raw)));
      } catch (e) { reject(e); }
    });
  }

  function fromOverpass() {
    var box = '(42.70,74.30,43.05,74.90)';
    var q = '[out:json][timeout:40];(' +
      'rel["boundary"="administrative"]["name"~"' + DISTRICT_STEMS + '"]' + box + ';' +
      'rel["boundary"="administrative"]["name:ru"~"' + DISTRICT_STEMS + '"]' + box + ';' +
      ');out geom;';
    var chain = Promise.reject(new Error('start'));
    OVERPASS.forEach(function (url) {
      chain = chain.catch(function () {
        return fetch(url + '?data=' + encodeURIComponent(q)).then(check);
      });
    });
    return chain.then(function (json) {
      var geo = cleanDistricts(osmtogeojson(json));
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(geo)); } catch (e) { /* пропускаем */ }
      return geo;
    });
  }

  function loadDistricts() {
    fromLocalFile()
      .catch(fromCache)
      .catch(fromOverpass)
      .then(function (geo) { districtsGeo = geo; })
      .catch(function (err) {
        console.warn('Границы районов не загрузились, рисуем круги', err);
        districtsError = err && err.message ? err.message : 'неизвестная ошибка';
        districtsGeo = null;
      })
      .then(renderMap);
  }

  // ---------- Карта ----------
  function initMap() {
    if (typeof L === 'undefined') {
      $('map').textContent = 'Не удалось загрузить карту. Проверьте интернет.';
      return;
    }
    map = L.map('map').setView([CITY.lat, CITY.lon], 11);

    // Тёмная подложка Esri (ключ не нужен) + слой с названиями улиц
    var esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
    var base = L.tileLayer(esri + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      maxNativeZoom: 16,
      attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors'
    }).addTo(map);
    var labels = L.tileLayer(esri + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      maxNativeZoom: 16
    }).addTo(map);

    // Если Esri не отвечает, переключаемся на обычную карту OpenStreetMap (затемняем фильтром)
    var tileErrors = 0;
    var switched = false;
    base.on('tileerror', function () {
      tileErrors++;
      if (tileErrors < 6 || switched) return;
      switched = true;
      map.removeLayer(base);
      map.removeLayer(labels);
      $('map').classList.add('map--dark-filter');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(map);
    });

    districtLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    loadDistricts();
  }

  function renderMap() {
    if (!map || !state.points.length) return;
    districtLayer.clearLayers();
    markerLayer.clearLayers();
    state.zones = [];

    if (districtsGeo) {
      var layer = L.geoJSON(districtsGeo, {
        style: function (f) {
          var c = L.geoJSON(f).getBounds().getCenter();
          var aqi = estimateAt(c.lat, c.lng);
          state.zones.push({ name: featureName(f), aqi: aqi });
          return zoneStyle(aqi);
        },
        onEachFeature: function (f, l) {
          var z = state.zones.filter(function (x) { return x.name === featureName(f); })[0];
          if (z) l.bindTooltip(featureName(f) + ' · AQI ≈ ' + round(z.aqi), { sticky: true });
        }
      }).addTo(districtLayer);
      if (!fitted) {
        map.fitBounds(layer.getBounds(), { padding: [12, 12] });
        fitted = true;
      }
      $('mapNote').textContent = 'Цвет района — оценка по ближайшим точкам измерения: от белого к красному. Датчиков в городе пока мало, поэтому это прототип.';
    } else {
      // запасной вариант: круги вокруг точек
      state.points.forEach(function (p) {
        L.circle([p.lat, p.lon], Object.assign({ radius: 2200 }, zoneStyle(p.aqi)))
          .bindTooltip(p.name + ' · AQI ' + round(p.aqi), { sticky: true })
          .addTo(districtLayer);
      });
      $('mapNote').textContent = 'Границы районов не загрузились (' + districtsError +
        '), показаны зоны вокруг точек измерения. Обновите страницу.';
    }

    state.points.forEach(function (p) {
      var icon = L.divIcon({
        className: 'pt-wrap',
        html: '<span class="pt">' + round(p.aqi) + '</span>',
        iconSize: [34, 34],
        iconAnchor: [17, 17]
      });
      L.marker([p.lat, p.lon], { icon: icon, title: p.name, alt: p.name })
        .bindTooltip(p.name + ' · PM2.5 ' + fmt1(p.pm25) + ' µg/м³', { direction: 'top', offset: [0, -14] })
        .addTo(markerLayer);
    });
  }

  // ---------- Карточки ----------
  function renderIndex() {
    var c = state.city;
    var lvl = levelOf(c.aqi);
    var val = $('aqiValue');
    val.textContent = round(c.aqi);
    val.style.color = lvl.color;
    $('aqiLabel').textContent = lvl.label;
    $('aqiText').textContent = lvl.advice;
    $('aqiMeta').textContent = 'PM2.5: ' + fmt1(c.pm25) + ' µg/м³ · PM10: ' + fmt1(c.pm10) + ' µg/м³';
    renderProfile();
    $('brandDot').style.background = lvl.color;
    $('updated').textContent = 'Обновлено в ' + hhmm(state.updatedAt);
  }

  function renderChart() {
    var box = $('chart');
    box.innerHTML = '';
    if (!state.history.length) {
      box.textContent = 'Нет данных за 24 часа';
      return;
    }
    var max = 100;
    state.history.forEach(function (h) { if (h.aqi > max) max = h.aqi; });

    state.history.forEach(function (h) {
      var bar = document.createElement('div');
      bar.className = 'chart__bar';
      bar.style.height = Math.max(3, h.aqi / max * 100) + '%';
      bar.style.background = levelOf(h.aqi).color;
      bar.title = hhmm(h.time) + ' · AQI ' + round(h.aqi);
      box.appendChild(bar);
    });

    var first = state.history[0];
    var last = state.history[state.history.length - 1];
    box.setAttribute('aria-label',
      'График индекса воздуха за 24 часа: с ' + round(first.aqi) + ' до ' + round(last.aqi));
  }

  function renderAll() {
    renderIndex();
    renderChart();
    renderBest();
    renderWeather();
    renderMap();
  }

  function showError() {
    $('updated').textContent = 'Нет связи с Open-Meteo';
    if (!state.city) {
      $('aqiLabel').textContent = 'Не удалось загрузить данные';
      $('aqiText').textContent = 'Проверьте интернет, страница попробует снова через минуту.';
    }
  }

  // ---------- Контекст для AI ----------
  function buildAiContext() {
    if (!state.city) return 'Данные о воздухе пока не загружены.';
    var lines = [];
    lines.push('Город: ' + state.city.name + '. Время данных: ' + state.updatedAt + ' (Asia/Bishkek).');
    lines.push('Индекс US AQI: ' + round(state.city.aqi) + ' (' + levelOf(state.city.aqi).label + '). PM2.5: ' +
      fmt1(state.city.pm25) + ' µg/м³, PM10: ' + fmt1(state.city.pm10) + ' µg/м³.');
    lines.push('По точкам города:');
    state.points.forEach(function (p) {
      lines.push('- ' + p.name + ': AQI ' + round(p.aqi) + ', PM2.5 ' + fmt1(p.pm25));
    });
    if (state.zones.length) {
      lines.push('По районам (оценка по ближайшим точкам):');
      state.zones.forEach(function (z) {
        lines.push('- ' + z.name + ': AQI ≈ ' + round(z.aqi));
      });
    }
    if (state.history.length) {
      lines.push('AQI за последние часы: ' + state.history.map(function (h) { return round(h.aqi); }).join(', ') + '.');
    }
    if (state.weather) {
      var w = state.weather;
      lines.push('Погода: ' + w.desc.toLowerCase() + ', ' + round(w.temp) + '°C (ощущается ' + round(w.feels) +
        '°C), ветер ' + fmt1(w.wind) + ' м/с, влажность ' + round(w.humidity) + '%.');
    }
    if (state.forecast && state.forecast.length) {
      lines.push('Прогноз AQI на ближайшие часы: ' + state.forecast.map(function (h) {
        return h.time.slice(11, 13) + 'ч=' + round(h.aqi);
      }).join(', ') + '.');
    }
    var bt = bestText();
    if (bt) lines.push('Лучшее время для прогулки по прогнозу: ' + bt + '.');
    lines.push('Профиль пользователя: ' + PROFILES[profileKey].label + ' (учитывай это в советах).');
    lines.push('Источник: Open-Meteo (модельные данные, не датчики).');
    return lines.join('\n');
  }
  window.buildAiContext = buildAiContext;

  // ---------- AI (Groq через Cloudflare Worker) ----------
  var SYSTEM_PROMPT =
    'Ты помощник сайта «Воздух Бишкека». Отвечай по-русски (если пользователь пишет на другом языке, отвечай на нём), ' +
    'коротко: 2–4 предложения, без заголовков и таблиц. Опирайся на данные ниже и не выдумывай цифры. ' +
    'Данные модельные (Open-Meteo), а не с датчиков; значения по районам оценочные, говори об этом, если спрашивают про район. ' +
    'Давай практические советы: прогулки, спорт, проветривание, маска, дети, астма. Ты не врач: при проблемах со здоровьем ' +
    'советуй обратиться к врачу. Если вопрос не про воздух, погоду или здоровье на улице, вежливо верни разговор к теме.';

  var convo = []; // история диалога: { role: 'user' | 'assistant', text }

  function cleanAnswer(t) {
    return t.replace(/\*\*/g, '').replace(/^\s*[*-]\s+/gm, '• ').trim();
  }

  function askAI() {
    var cfg = window.AQ_CONFIG || {};
    if (!cfg.AI_PROXY_URL) return Promise.reject(new Error('AI не настроен: укажите AI_PROXY_URL в config.js'));

    var body = {
      system: SYSTEM_PROMPT + '\n\nДАННЫЕ СЕЙЧАС:\n' + buildAiContext(),
      messages: convo.slice(-10).map(function (m) { return { role: m.role, content: m.text }; })
    };

    function attempt(n) {
      return fetch(cfg.AI_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, json: j }; });
      }).then(function (res) {
        if (!res.ok) {
          var retry = res.status === 429 || res.status >= 500;
          if (retry && n < 1) {
            // временный сбой или лимит: ждём немного и пробуем ещё раз
            return new Promise(function (resolve) { setTimeout(resolve, 1500); })
              .then(function () { return attempt(n + 1); });
          }
          var msg = res.json && res.json.error && res.json.error.message;
          throw new Error(msg || ('HTTP ' + res.status));
        }
        var choice = res.json.choices && res.json.choices[0];
        var text = choice && choice.message && choice.message.content;
        if (!text) throw new Error('пустой ответ модели');
        return cleanAnswer(text);
      });
    }
    return attempt(0);
  }

  // Простая сводка по данным, если AI недоступен
  function localSummary() {
    if (!state.city) return 'Данные ещё загружаются, попробуйте через пару секунд.';
    var list = state.zones.length ? state.zones : state.points;
    var sorted = list.slice().sort(function (a, b) { return a.aqi - b.aqi; });
    var best = sorted[0];
    var worst = sorted[sorted.length - 1];
    return 'Сейчас в Бишкеке AQI ' + round(state.city.aqi) + ': ' + levelOf(state.city.aqi).label.toLowerCase() + '.\n' +
      'Чище всего: ' + best.name + ' (' + round(best.aqi) + '), хуже всего: ' + worst.name + ' (' + round(worst.aqi) + ').';
  }

  // ---------- Чат ----------
  var log = $('chatLog');
  var input = $('chatInput');
  var sendBtn = document.querySelector('.chat__send');
  var busy = false;

  function addMsg(role, text, extraClass) {
    var el = document.createElement('div');
    el.className = 'msg ' + (role === 'user' ? 'msg--user' : 'msg--bot') + (extraClass ? ' ' + extraClass : '');
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function setBusy(v) {
    busy = v;
    input.disabled = v;
    sendBtn.disabled = v;
    log.setAttribute('aria-busy', v ? 'true' : 'false');
  }

  function ask(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    addMsg('user', text);
    convo.push({ role: 'user', text: text });
    var wait = addMsg('bot', 'Думаю…', 'msg--typing');
    var started = Date.now();
    var timer = setInterval(function () {
      wait.textContent = 'Думаю… ' + Math.round((Date.now() - started) / 1000) + ' с';
    }, 1000);
    setBusy(true);

    askAI().then(function (answer) {
      convo.push({ role: 'assistant', text: answer });
      wait.textContent = answer;
      wait.classList.remove('msg--typing');
    }).catch(function (err) {
      console.error('Ошибка AI', err);
      convo.pop(); // убираем вопрос без ответа
      wait.textContent = 'Не удалось получить ответ от AI (' + err.message + ').\n\n' + localSummary();
      wait.classList.remove('msg--typing');
    }).then(function () {
      clearInterval(timer);
      setBusy(false);
      log.scrollTop = log.scrollHeight;
      if (window.matchMedia('(hover: hover)').matches) input.focus();
    });
  }

  $('chatForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = input.value;
    input.value = '';
    ask(v);
  });

  Array.prototype.forEach.call(document.querySelectorAll('.suggest__btn'), function (btn) {
    btn.addEventListener('click', function () { ask(btn.getAttribute('data-q')); });
  });

  // ---------- Запуск ----------
  function refresh() {
    loadAll().then(renderAll).catch(function (err) {
      console.error(err);
      showError();
      setTimeout(refresh, 60 * 1000);
    });
  }

  initMap();
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
