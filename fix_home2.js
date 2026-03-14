const fs = require('fs');

let homehtml = fs.readFileSync('templates/home.html', 'utf8');

// The original section is: <section id="hero-carousel-section" class="relative h-[60vh] md:h-[90vh] overflow-hidden bg-primary">
// To keep it 80% screen max and not cut off the images, let's adjust the wrapper section class
homehtml = homehtml.replace(/<section id="hero-carousel-section" class="relative h-\[60vh\] md:h-\[90vh\] overflow-hidden bg-primary">/, '<section id="hero-carousel-section" class="relative h-[65vh] min-h-[400px] max-h-[80vh] overflow-hidden bg-black">');

// The images were already replaced with `object-cover object-center opacity-70` via previous script/regex that didn't catch the container properly because the original changed.

// Let's also fix slide 3 link if it wasn't caught
homehtml = homehtml.replace(/href="#\/products"\s+data-i18n="slide3Button"/, 'href="#/products?category=para-casal" data-i18n="slide3Button"');
// Wait, slide 1 is 5% off, slide 2 is luxury, slide 3 is new arrivals.
// The user said: "na foto 2 do hero ao clicar no hero evia de ir para uma categoria chamada premium". Slide 2 (Luxo) has href to `#products?category=premium` which we fixed above.
// The user said: "na foto 3 do hero ao ir para https://darkdesire.pt/#/products?category=para-casal devia de mostrar os produtos..."
// Slide 3 currently has `<a class="..." href="#/products" data-i18n="slide3Button">`
// Let's replace that specifically
homehtml = homehtml.replace(/href="#\/products"\s+data-i18n="slide3Button"/, 'href="#/products?category=para-casal" data-i18n="slide3Button"');

fs.writeFileSync('templates/home.html', homehtml);
