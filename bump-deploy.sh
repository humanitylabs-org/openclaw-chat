#!/bin/bash
# Auto-bump all cache version strings and deploy
set -e

# Bump sw.js CACHE_VERSION
perl -i -pe 's/const CACHE_VERSION = "v(\d+)"/sprintf("const CACHE_VERSION = \"v%d\"", $1+1)/e' sw.js

# Bump app.js?v= in index.html
perl -i -pe 's/app\.js\?v=(\d+)/sprintf("app.js?v=%d", $1+1)/e' index.html

# Bump theme.css?v= in index.html
perl -i -pe 's/theme\.css\?v=(\d+)/sprintf("theme.css?v=%d", $1+1)/e' index.html

echo "Versions bumped:"
grep 'CACHE_VERSION' sw.js
grep 'app.js?v=' index.html
grep 'theme.css?v=' index.html

git add -A && git commit -m "deploy: bump cache versions" && git push
vercel --prod --scope humanity-labs-b649590f --yes
