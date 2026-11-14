TarjimReference.start({
  deliveryUrl: 'https://delivery.example.com/delivery/0123456789abcdef0123456789abcdef/meta', // the Delivery URL from the console
  apiKey: 'YOUR-DELIVERY-KEY', // the stage's key, tj_dev_… or tj_prod_…; it is public in this page
  appVersion: '1.0.0', // your site's release; change it on every deploy
  defaultBundle: { type: 'custom', name: 'web' }, // one of your distribution's bundles
  language: document.documentElement.lang,
  fallbackLanguage: 'en',
}).then(function (tarjim) {
  document.querySelectorAll('[data-key]').forEach(function (element) {
    element.textContent = tarjim.t(element.getAttribute('data-key'));
  });
});
