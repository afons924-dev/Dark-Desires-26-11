const fs = require('fs');

let appjs = fs.readFileSync('js/app.js', 'utf8');
appjs = appjs.replace(
    /if \(p\.categories && Array\.isArray\(p\.categories\) && p\.categories\.length > 0\) \{\n                p\.categories\.forEach\(cat => \{\n                    categoryCounts\[cat\] = \(categoryCounts\[cat\] \|\| 0\) \+ 1;\n                \}\);\n            \} else \{\n                if \(p\.categories && Array\.isArray\(p\.categories\) && p\.categories\.length > 0\) \{\n                p\.categories\.forEach\(cat => \{\n                    categoryCounts\[cat\] = \(categoryCounts\[cat\] \|\| 0\) \+ 1;\n                \}\);\n            \} else \{\n                const category = p\.category \|\| 'Outros';\n                categoryCounts\[category\] = \(categoryCounts\[category\] \|\| 0\) \+ 1;\n            \}\n            \}/,
    `if (p.categories && Array.isArray(p.categories) && p.categories.length > 0) {
                p.categories.forEach(cat => {
                    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
                });
            } else {
                const category = p.category || 'Outros';
                categoryCounts[category] = (categoryCounts[category] || 0) + 1;
            }`
);
fs.writeFileSync('js/app.js', appjs);
