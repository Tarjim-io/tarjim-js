Tarjim.start({
  deliveryUrl: 'https://delivery.example.com/delivery/0123456789abcdef0123456789abcdef/meta', // the Delivery URL from the console
  apiKey: 'YOUR-DELIVERY-KEY', // the stage's key, tj_dev_… or tj_prod_…; it is public in this page
  appVersion: '1.0.0', // your site's release; change it on every deploy
  defaultBundle: { type: 'custom', name: 'web' }, // one of your distribution's bundles
  fallbackLanguage: 'en',
  waitForContent: 3000, // wait up to 3 seconds for the first download, then show what is held
}).then(function (tarjim) {
  function render() {
    document.documentElement.lang = tarjim.language;
    document.documentElement.dir = tarjim.language.split('-')[0] === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('[data-key]').forEach(function (element) {
      // textContent only: translated values are untrusted text.
      element.textContent = tarjim.t(element.getAttribute('data-key'));
    });
  }

  render();
  // A newer release is activated while the page is open; draw it again.
  tarjim.on('activated', render);
  tarjim.on('languageChanged', render);

  document.getElementById('switch-language').addEventListener('click', function () {
    tarjim.setLanguage(tarjim.language === 'ar' ? 'en' : 'ar').catch(function () {
      // The release has no text for that language; keep showing the current one.
    });
  });
});
