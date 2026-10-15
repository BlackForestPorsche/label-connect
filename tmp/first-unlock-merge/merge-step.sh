set -euo pipefail
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch origin main
git merge --no-commit origin/main || true
cp tmp/first-unlock-merge/version.json extension/version.json
sed -i 's/"version": "0.1.35"/"version": "0.1.36"/' package.json extension/firefox/manifest.json extension/chromium/manifest.json
npm run sync-extension >/dev/null
git rm -rqf --cached tmp/first-unlock-merge >/dev/null 2>&1 || true
sha256sum -c tmp/first-unlock-merge/expected.sha256
node --test test/desk-lock-unlock-gaps.test.mjs test/desk-first-unlock.test.mjs test/desk-update-signed-feed.test.mjs test/desk-manifest-parity.test.mjs test/desk-update.test.mjs
git add -A -- . ':!tmp'
git rm -rqf tmp/first-unlock-merge 2>/dev/null || true
git commit -m "Merge main (Desk 0.1.35 signed feed) into first-unlock fix; bump Desk to 0.1.36"
git push origin HEAD
