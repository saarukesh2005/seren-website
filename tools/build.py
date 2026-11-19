"""Bundle src/ into: dist/index.html (published page) and site/ (standalone site you can host anywhere)."""
import os, shutil

SRC, DIST, SITE = "src", "dist", "site"

def read(p):
    with open(os.path.join(SRC, p), encoding="utf-8") as f:
        return f.read()

def bundle():
    page = read("index.html")
    css = "\n".join(read(p) for p in ["styles.css", "effects.css"])
    js = "\n".join(read(p) for p in ["menu.js", "palettes.js", "render.js", "motion.js", "interactions.js"])
    if "</script" in js.lower():
        raise ValueError("script text contains a closing script tag")
    page = page.replace("<!--STYLES-->", f"<style>\n{css}\n</style>")
    page = page.replace("<!--SCRIPTS-->", f"<script>\n{js}\n</script>")
    return page

def main():
    page = bundle()
    for out in (DIST, SITE):
        if os.path.isdir(os.path.join(out, "img")):
            shutil.rmtree(os.path.join(out, "img"))
        os.makedirs(out, exist_ok=True)
        shutil.copytree(os.path.join(SRC, "img"), os.path.join(out, "img"))
    with open(os.path.join(DIST, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)
    head = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            '<link rel="icon" href="favicon.svg" type="image/svg+xml">\n'
            '<meta property="og:title" content="SEREN Entremets">\n'
            '<meta property="og:description" content="Bomboloni, cookies, illusory fruit, entremets, gelato, chocolates and a wood-fired kitchen.">\n'
            '<meta property="og:image" content="img/bonbon-caramel.webp">\n')
    body_start = page.index("<svg width=\"0\"")
    standalone = head + page[:body_start] + "</head>\n<body>\n" + page[body_start:] + "\n</body>\n</html>\n"
    for extra in os.listdir(os.path.join(SRC, "static")):
        shutil.copy(os.path.join(SRC, "static", extra), os.path.join(SITE, extra))
    open(os.path.join(SITE, ".nojekyll"), "w").close()
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as f:
        f.write(standalone)
    print("built", len(page) // 1024, "KB page")

if __name__ == "__main__":
    main()
