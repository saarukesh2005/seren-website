"""Bundle src/ into: dist/index.html (published page) and site/ (standalone site you can host anywhere)."""
import base64, hashlib, os, re, shutil

SRC, DIST, SITE = "src", "dist", "site"

def read(p):
    with open(os.path.join(SRC, p), encoding="utf-8") as f:
        return f.read()

PAGES = {
    # page: (template, stylesheets, scripts)
    "index.html": ("index.html", ["styles.css", "effects.css", "checkout.css", "i18n.css"],
                   ["menu.js", "i18n-ta.js", "i18n.js", "catalog.js", "palettes.js", "render.js", "motion.js", "interactions.js", "pay.js", "checkout.js", "products.js", "table.js"]),
    "order.html": ("order.html", ["styles.css", "effects.css", "checkout.css", "order.css", "i18n.css"],
                   ["menu.js", "i18n-ta.js", "i18n.js", "palettes.js", "pay.js", "order.js"]),
}

# https:// for any host; plain http:// only for a server running on this computer (local testing)
API_PATTERN = re.compile(r"https://[A-Za-z0-9.-]+(:\d+)?|http://(127\.0\.0\.1|localhost)(:\d+)?")

def api_address():
    api = os.environ.get("SEREN_API", "").strip()
    if api and not API_PATTERN.fullmatch(api):
        raise ValueError("SEREN_API must look like https://name.workers.dev (http:// only for 127.0.0.1 or localhost)")
    return api

def config_js():
    """menu.js, with the order-system address swapped in when SEREN_API is set (used for local testing)."""
    js = read("menu.js")
    api = api_address()
    if api:
        marker = 'api: "",'
        if marker not in js:
            raise ValueError("menu.js has no empty api setting to replace")
        js = js.replace(marker, f'api: "{api}",')
    return js

def bundle(name):
    template, styles, scripts = PAGES[name]
    page = read(template)
    css = "\n".join(read(p) for p in styles)
    js = "\n".join(config_js() if p == "menu.js" else read(p) for p in scripts)
    if "</script" in js.lower():
        raise ValueError("script text contains a closing script tag")
    page = page.replace("<!--STYLES-->", f"<style>\n{css}\n</style>")
    page = page.replace("<!--SCRIPTS-->", f"<script>\n{js}\n</script>")
    return page

def content_security_policy(page):
    """A Content-Security-Policy that lets only this page's own inline script (by hash), the pinned CDN
    libraries and the order system run. Inline event handlers (onclick=...) are not allowed by it."""
    markup = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", page, flags=re.S | re.I)
    if re.search(r"<[a-z][^>]*\son[a-z]+\s*=", markup, re.I):
        raise ValueError("the page has an inline event handler (onclick= etc.), which the security policy blocks; use addEventListener")
    scripts = re.findall(r"<script>(.*?)</script>", page, re.S)
    if not scripts:
        raise ValueError("no inline script found to allow in the security policy")
    hashes = " ".join("'sha256-" + base64.b64encode(hashlib.sha256(js.encode("utf-8")).digest()).decode() + "'" for js in scripts)
    api = api_address()
    return "; ".join([
        "default-src 'none'",
        f"script-src {hashes} https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        ("img-src 'self' data: blob: " + api).strip(),
        ("connect-src 'self' " + api).strip(),
        "base-uri 'none'", "form-action 'none'", "object-src 'none'", "manifest-src 'self'",
    ])

def standalone(page, body_attrs=""):
    head = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            f'<meta http-equiv="Content-Security-Policy" content="{content_security_policy(page)}">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            '<link rel="icon" href="favicon.svg" type="image/svg+xml">\n'
            '<meta property="og:title" content="SEREN Entremets">\n'
            '<meta property="og:description" content="Bomboloni, cookies, illusory fruit, entremets, gelato, chocolates and a wood-fired kitchen.">\n'
            '<meta property="og:image" content="img/bonbon-caramel.webp">\n')
    body_start = page.index("<svg width=\"0\"")
    return head + page[:body_start] + f"</head>\n<body{body_attrs}>\n" + page[body_start:] + "\n</body>\n</html>\n"

def main():
    page = bundle("index.html")
    for out in (DIST, SITE):
        if os.path.isdir(os.path.join(out, "img")):
            shutil.rmtree(os.path.join(out, "img"))
        os.makedirs(out, exist_ok=True)
        shutil.copytree(os.path.join(SRC, "img"), os.path.join(out, "img"))
    with open(os.path.join(DIST, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)
    for extra in os.listdir(os.path.join(SRC, "static")):
        shutil.copy(os.path.join(SRC, "static", extra), os.path.join(SITE, extra))
    open(os.path.join(SITE, ".nojekyll"), "w").close()
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as f:
        f.write(standalone(page))
    with open(os.path.join(SITE, "order.html"), "w", encoding="utf-8") as f:
        f.write(standalone(bundle("order.html"), ' class="order-page"'))
    print("built", len(page) // 1024, "KB page")

if __name__ == "__main__":
    main()
