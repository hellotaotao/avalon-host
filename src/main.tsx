import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import { App } from './App';
import { I18nProvider } from './i18n';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

if (import.meta.env.DEV && window.location.pathname === '/dev/multiplayer') {
  void import('./dev/DevMultiplayerSimulator').then(({ DevMultiplayerSimulator }) => {
    root.render(<I18nProvider><DevMultiplayerSimulator /></I18nProvider>);
  });
} else {
  // Page views go to Vercel Web Analytics on the deployed site only; local dev
  // and tests would otherwise load the debug script from Vercel's CDN.
  root.render(
    <I18nProvider>
      <App />
      {import.meta.env.PROD && <Analytics mode="production" />}
    </I18nProvider>,
  );
}
