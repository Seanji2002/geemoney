// Production deploys, migrations, and command registration run ONLY from
// GitHub Actions. Locally this refuses, so the CI pipeline (typecheck +
// tests) is the single path to production.
if (process.env.GITHUB_ACTIONS !== 'true') {
  console.error(
    '\n✘ Refusing: production deploys run only from GitHub Actions.\n' +
      '  Push to main (or merge a PR) and let CI deploy.\n' +
      '  Local development: npm run dev / npm run migrate:local\n',
  );
  process.exit(1);
}
