TarjimReference.start({
  deliveryUrl: 'https://delivery.example.com/t/1/projects/1/delivery/meta',
  apiKey: 'YOUR-DELIVERY-KEY', // a key bound to a track and stage; it is public in this page
  appVersion: '1.0.0', // your site's release; change it on every deploy
  defaultBundle: { type: 'namespace', name: 'default' },
  language: document.documentElement.lang,
  fallbackLanguage: 'en',
}).then(function (tarjim) {
  document.querySelectorAll('[data-key]').forEach(function (element) {
    element.textContent = tarjim.t(element.getAttribute('data-key'));
  });
});
