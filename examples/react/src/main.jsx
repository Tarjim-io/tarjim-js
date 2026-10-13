import { createRoot } from 'react-dom/client';
import { TarjimProvider } from '@tarjim/react';
import { App } from './App.jsx';

// Created once, outside any component: the provider reads its config at the first render only.
// The values come from .env.local (see README.md); nothing here is a real host or key.
const config = {
  deliveryUrl: import.meta.env.VITE_TARJIM_DELIVERY_URL,
  apiKey: import.meta.env.VITE_TARJIM_APIKEY,
  appVersion: import.meta.env.VITE_APP_VERSION ?? '0.0.0',
  defaultBundle: { type: 'namespace', name: 'default' },
  fallbackLanguage: 'en',
};

createRoot(document.getElementById('root')).render(
  <TarjimProvider config={config} fallback={<p>Loading…</p>}>
    <App />
  </TarjimProvider>,
);
