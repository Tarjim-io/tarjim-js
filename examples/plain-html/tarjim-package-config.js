Tarjim.start({
  deliveryUrl: 'https://delivery.example.com/copy/it/from/the/console/delivery/meta',
  apiKey: 'YOUR-DELIVERY-KEY', // a key bound to a track and stage; it is public in this page
  appVersion: '1.0.0', // your site's release; change it on every deploy
  defaultBundle: { type: 'namespace', name: 'default' },
  fallbackLanguage: 'en',
  language: document.documentElement.lang,
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
