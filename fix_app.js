const fs = require('fs');

let content = fs.readFileSync('js/app.js', 'utf8');

// Undo the categories array changes in the form reading
// Lines 2187-2189 are:
//        const categoryValue = getValue('category');
//        const categoryArray = categoryValue ? categoryValue.split(';').map(cat => cat.trim()).filter(cat => cat) : [];
//        const mainCategory = categoryArray.length > 0 ? categoryArray[0].toLowerCase() : (categoryValue ? categoryValue.toLowerCase() : '');

content = content.replace(
    /const categoryValue = getValue\('category'\);\s*const categoryArray = categoryValue \? categoryValue\.split\(';'\)\.map\(cat => cat\.trim\(\)\)\.filter\(cat => cat\) : \[\];\s*const mainCategory = categoryArray\.length > 0 \? categoryArray\[0\]\.toLowerCase\(\) : \(categoryValue \? categoryValue\.toLowerCase\(\) : ''\);/,
    `const categoryValue = getValue('category');`
);

content = content.replace(
    /category: mainCategory, \/\/ Mantemos main category em minúsculas como base string para compatibilidade fallback\s*categories: categoryArray, \/\/ Array de categorias reais/,
    `category: categoryValue ? categoryValue.toLowerCase() : '',`
);

// We need to change how multiple categories work based on user intent.
// The user wants to input multiple categories separated by `;`
// Ex: "categoria A; categoria B"
// So instead of `category` being a single string, we CAN save an array in `categories`, but then the main category should be `categoryArray[0]`.

// Wait, the user specifically asked for: "na criação de categorias ao pôr ; devia de puder criar multiplas categorias no caso categoraia A; categoria B; etc, no caso da foto 4 em anexo, na foto 3 do hero ao ir para https://darkdesire.pt/#/products?category=para-casal devia de mostrar os produtos de subcategoria para-casal o que atualmente é impossvile de selcionara no menu da foto 5 em anexo"
