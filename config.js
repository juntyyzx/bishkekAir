// Настройки AI. Запросы идут через Cloudflare Worker (см. worker.js),
// ключ Groq хранится только в Cloudflare и в файлах сайта его нет.
window.AQ_CONFIG = {
  AI_PROXY_URL: 'https://square-sun-d2a3.juntuy242010.workers.dev'
};
