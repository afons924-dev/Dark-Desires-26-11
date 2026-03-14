const fs = require('fs');

let appjs = fs.readFileSync('js/app.js', 'utf8');

// The `subcategory` logic is deeply ingrained in the staged changes. Let's reset `js/app.js` and `templates/products.html` to HEAD and start fresh.
