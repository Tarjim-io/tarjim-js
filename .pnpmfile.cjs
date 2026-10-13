// `react-dom-18` is react-dom 18 under another name, for the second test run against React 18. By default
// pnpm would give it the workspace's React 19; this gives it the React 18 it needs.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'react-dom' && pkg.version === '18.3.1') {
        pkg.dependencies = { ...pkg.dependencies, react: '18.3.1' };
        delete pkg.peerDependencies.react;
      }
      return pkg;
    },
  },
};
