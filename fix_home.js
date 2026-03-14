const fs = require('fs');

let homehtml = fs.readFileSync('templates/home.html', 'utf8');

// 1. Make hero slider container 80% max screen height and min 400px. The original is:
// <div class="relative h-[500px] md:h-[600px] overflow-hidden" id="hero-slider">
homehtml = homehtml.replace(/<div class="relative h-\[500px\] md:h-\[600px\] overflow-hidden" id="hero-slider">/, '<div class="relative h-[65vh] min-h-[400px] max-h-[80vh] overflow-hidden bg-black" id="hero-slider">');

// 2. Make images scale nicely
// Original: class="absolute inset-0 w-full h-full object-cover"
homehtml = homehtml.replace(/class="absolute inset-0 w-full h-full object-cover"/g, 'class="absolute inset-0 w-full h-full object-cover object-center opacity-70"');

// 3. Fix the link in slide 2
// Slide 2 has href="#/products?category=luxo" data-i18n="slide1Button"
// The user says "na foto 2 do hero ao clicar no hero evia de ir para uma categoria chamada premium"
homehtml = homehtml.replace(/href="#\/products\?category=luxo"\s*data-i18n="slide1Button"/, 'href="#/products?category=premium" data-i18n="slide1Button"');

// 4. Fix the link in slide 3
// Slide 3 has href="#/products" data-i18n="slide3Button"
// The user says "na foto 3 do hero ao ir para https://darkdesire.pt/#/products?category=para-casal devia de mostrar os produtos de subcategoria para-casal"
homehtml = homehtml.replace(/href="#\/products"\s*data-i18n="slide3Button"/, 'href="#/products?category=para-casal" data-i18n="slide3Button"');

fs.writeFileSync('templates/home.html', homehtml);
