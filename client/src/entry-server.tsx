import ReactDOMServer from 'react-dom/server';
import { HelmetProvider, type HelmetServerState } from 'react-helmet-async';
import App from './App';

export function render() {
  const helmetContext: { helmet?: HelmetServerState } = {};
  const appHtml = ReactDOMServer.renderToString(
    <HelmetProvider context={helmetContext}>
      <App />
    </HelmetProvider>,
  );

  const helmet = helmetContext.helmet;
  const headHtml = helmet
    ? [helmet.title, helmet.meta, helmet.link, helmet.script]
        .filter(Boolean)
        .map((x) => x.toString())
        .join('')
    : '';

  return { appHtml, headHtml };
}
