import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = (path) => fileURLToPath(new URL(path, import.meta.url));
const react = (path) => root(`./node_modules/react-18/${path}`);
const dom = (path) => root(`./node_modules/react-dom-18/${path}`);

// The same tests as `pnpm test`, against React 18: the package supports it, and the default run is on 19.
export default defineConfig({
  root: root('../..'),
  resolve: {
    alias: [
      { find: '@tarjim/core/internal', replacement: root('../core/src/internal.ts') },
      { find: '@tarjim/core', replacement: root('../core/src/index.ts') },
      { find: '@tarjim/browser/internal', replacement: root('../browser/src/internal.ts') },
      { find: '@tarjim/browser', replacement: root('../browser/src/index.ts') },
      // Its CommonJS build would load React with a plain require, past the aliases below; the ES module build imports it.
      { find: /^@testing-library\/react$/, replacement: root('./node_modules/@testing-library/react/dist/@testing-library/react.esm.js') },
      { find: /^react$/, replacement: react('index.js') },
      { find: /^react\/jsx-runtime$/, replacement: react('jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: react('jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: dom('index.js') },
      { find: /^react-dom\/client$/, replacement: dom('client.js') },
      { find: /^react-dom\/server$/, replacement: dom('server.node.js') },
      { find: /^react-dom\/test-utils$/, replacement: dom('test-utils.js') },
    ],
  },
  test: {
    include: ['packages/react/test/**/*.test.tsx'],
    env: { REACT_MAJOR: '18' },
    // Processed here rather than loaded as is, so that its imports of React go through the aliases above.
    server: { deps: { inline: [/@testing-library\/react/] } },
  },
});
