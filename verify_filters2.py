from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})

    print("Navigating to products page...")
    page.goto("http://localhost:8000/#/products")
    time.sleep(3)

    print("Handling age gate if present...")
    try:
        age_btn = page.get_by_role("button", name="TENHO 18+ ANOS")
        if age_btn.is_visible(timeout=3000):
            age_btn.click()
            time.sleep(1)
    except Exception as e:
        pass

    print("Opening filter menu...")
    # Wait until category filter list is populated (or just wait a bit)
    page.wait_for_selector("#category-filter-list li", timeout=5000)

    page.evaluate('''() => {
        const header = document.querySelector(".accordion-header");
        if(header) {
            header.click();
            setTimeout(() => {
                const body = header.nextElementSibling;
                body.style.maxHeight = "1000px";
                body.style.overflow = "visible";
            }, 500);
        }
    }''')
    time.sleep(2)

    print("Taking screenshot of products page with filters open...")
    page.screenshot(path="filters_desktop_open3.png")

    browser.close()
    print("Verification complete.")
