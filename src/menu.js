/* SEREN menu content. Names and descriptions come from the SEREN recipe book.
   Prices are not in the book: fill PRICE values (in rupees) when ready, or leave null to hide them. */
window.SEREN_CONFIG = {
  instagram: "seren",          // shown as @seren
  whatsapp: "",                // e.g. "919876543210" (country code, no +). Empty hides the WhatsApp button.
  phone: "",                   // shown as text in the Visit section
  address: "",                 // store address
  hours: "",                   // e.g. "Tue–Sun · 11am–11pm"
  currency: "₹",
  api: "",                     // the order system's web address (Cloudflare Worker). Empty = orders go by WhatsApp / copy.
  palette: "SEREN Original",    // the site's colours: any name from palettes.js
  showPalettePicker: true,     // preview tool; set false before launch
};

window.SEREN_MENU = {
  bomboloni: [
    { id: "bomb-tiramisu", name: "Bombolone al Tiramisù", en: "Tiramisu", desc: "Mascarpone & coffee cream, espresso-Kahlúa soak, ladyfinger crumb.", img: "bomb-tiramisu", notes: ["Mascarpone cream", "Coffee soak"] },
    { id: "bomb-cheesecake", name: "Bombolone alla Cheesecake ai Mirtilli", en: "Blueberry cheesecake", desc: "Cream cheese filling with a bright blueberry compote.", img: "bomb-cheesecake", notes: ["Cream cheese", "Blueberry compote"] },
    { id: "bomb-vanilla", name: "Bombolone alla Vaniglia", en: "Vanilla", desc: "Silky vanilla pastry cream that runs when you bite.", img: "bomb-vanilla", notes: ["Vanilla pastry cream"] },
    { id: "bomb-hazelnut", name: "Bombolone alla Nocciola", en: "Hazelnut", desc: "Roasted hazelnut ganache, rich and nutty.", img: "bomb-hazelnut", notes: ["Hazelnut ganache"] },
    { id: "bomb-strawberry", name: "Bombolone alla Fragola", en: "Strawberry", desc: "Strawberry cream with a ribbon of strawberry compote.", img: "bomb-strawberry", notes: ["Strawberry cream", "Compote"] },
    { id: "bomb-chocolate", name: "Bombolone al Cioccolato", en: "Chocolate", desc: "Glossy dark chocolate ganache, finished with butter.", img: "bomb-chocolate", notes: ["Chocolate ganache"] },
    { id: "bomb-miso", name: "Miso-Caramel Bombolone", en: "Miso caramel", desc: "White-miso caramel over a chocolate crémeux. Salty, sweet, deep.", img: "bomb-miso", notes: ["Miso caramel", "Chocolate crémeux"] },
  ],

  cookies: [
    { id: "cookie-biscoff", name: "Biscoff", desc: "Brown-butter dough, Biscoff spread centre, cinnamon.", img: "cookie-biscoff", hover: "cookie-biscoff-x" },
    { id: "cookie-seasalt", name: "Sea Salt Chocochip", desc: "Chopped and whole dark chocolate, flaky salt on top.", img: "cookie-seasalt" },
    { id: "cookie-brownie", name: "Brownie", desc: "70% dark chocolate, crackled top, fudgy middle.", img: "cookie-brownie" },
    { id: "cookie-redvelvet", name: "Red Velvet Cream Cheese", desc: "Cocoa red velvet stuffed with cream cheese.", img: "cookie-redvelvet" },
    { id: "cookie-hazelnut", name: "Hazelnut", desc: "Chocolate dough with a hazelnut spread core.", img: "cookie-hazelnut" },
    { id: "cookie-matcha", name: "Matcha", desc: "Matcha dough, white chocolate chunks and ganache.", img: "cookie-matcha" },
    { id: "cookie-triple", name: "Triple Chocolate", desc: "Charcoal-dark dough with dark, milk and white chocolate.", img: "cookie-triple" },
  ],

  fruit: [
    { id: "fruit-strawberry", name: "Strawberry", desc: "Strawberry mousse around a strawberry centre, in a ruby shell.", img: "fruit-strawberry", layers: ["Red shell", "Strawberry mousse", "Strawberry filling"] },
    { id: "fruit-cocoa", name: "Cocoa Pod", desc: "Dark chocolate mousse, hazelnut praline, cocoa sponge.", img: "fruit-cocoa", layers: ["Cocoa shell", "Dark chocolate mousse", "Hazelnut praline"] },
    { id: "fruit-pear", name: "Pear", desc: "Pear mousse with a pear jelly heart on sponge.", img: "fruit-pear", layers: ["Pear shell", "Pear mousse", "Pear jelly insert", "Sponge"] },
    { id: "fruit-banana", name: "Banana", desc: "Banana mousse with a salted caramel core.", img: "fruit-banana", layers: ["Banana shell", "Banana mousse", "Salted caramel"] },
    { id: "fruit-coconut", name: "Coconut", desc: "Coconut mousse hiding a burst of liquid coconut water.", img: "fruit-coconut", layers: ["White shell", "Coconut mousse", "Coconut water sphere"] },
    { id: "fruit-coffee", name: "Coffee Bean × Tiramisu", desc: "Coffee mousse and caramel ganache in dark chocolate.", img: "fruit-coffee", layers: ["Dark chocolate shell", "Coffee mousse", "Caramel ganache"] },
    { id: "fruit-mango", name: "Mango", desc: "Mango cream-cheese mousse around a mango-lime insert.", img: "fruit-mango", layers: ["Mango shell", "Mango mousse", "Mango insert"] },
    { id: "fruit-blueberry", name: "Blueberry", desc: "Blueberry mousse with a whole-berry insert.", img: "fruit-blueberry", layers: ["Blue shell", "Blueberry mousse", "Blueberry insert"] },
    { id: "fruit-almond", name: "Almond", desc: "Almond mousse, almond praline and a caramel core.", img: "fruit-almond", layers: ["Almond shell", "Almond mousse", "Praline", "Caramel core"] },
  ],

  entremets: [
    { id: "ent-hazelnut", name: "Hazelnut Symphony", kicker: "Hazelnut chocolate entremet",
      layers: [["Chocolate mirror glaze", "#3a1c16"], ["Hazelnut mousse", "#b88a5e"], ["Milk chocolate crémeux", "#7a4a2c"], ["Hazelnut praline crunch", "#c69c62"], ["Vanilla sponge", "#e9cf98"]] },
    { id: "ent-strawberry", name: "Strawberry Entremet", kicker: "Bright and airy",
      layers: [["Strawberry mirror glaze", "#b3203a"], ["Strawberry mousse", "#f2a7b4"], ["Strawberry crémeux", "#d9566c"], ["Strawberry gel", "#9e1b30"], ["Vanilla sponge", "#e9cf98"]] },
    { id: "ent-whitebiscoff", name: "White Chocolate × Biscoff", kicker: "Toasted white chocolate",
      layers: [["Dark chocolate glaze", "#2b1712"], ["Chocolate mousse", "#8a5a3c"], ["Biscuit ganache", "#c48a4f"], ["Chocolate sponge", "#4e2b1d"], ["Chocolate wafer crust", "#6b3b22"]] },
    { id: "ent-hazelbiscoff", name: "Hazelnut × Biscoff", kicker: "Nutty, spiced, crunchy",
      layers: [["Dark chocolate glaze", "#2b1712"], ["Hazelnut chocolate mousse", "#a0744d"], ["Biscoff ganache", "#c9894a"], ["Cocoa sponge", "#4e2b1d"], ["Chocolate wafer crust", "#6b3b22"]] },
  ],

  pastry: [
    { id: "choux-almond", name: "Almond Praline Choux", desc: "Charcoal craquelin, almond praline heart, vanilla cream.", img: "choux-almond", hover: "choux-almond-x" },
    { id: "choux-matcha", name: "Matcha Choux", desc: "Matcha craquelin, matcha cream, white chocolate ganache.", img: "choux-matcha", hover: "choux-matcha-x" },
    { id: "choux-classic", name: "Choux au Craquelin", desc: "Crisp sugared crust over a light choux puff.", img: "choux-classic" },
    { id: "tart-hazelnut", name: "Hazelnut Tart", desc: "Hazelnut chocolate filling in a crisp tart shell.", img: "tart-hazelnut" },
    { id: "tart-citron", name: "Citron Tart", desc: "Lemon curd, almond frangipane, meringue, citron glaze.", img: "tart-citron" },
    { id: "tiramisu", name: "Classic Tiramisù", desc: "Mascarpone cream and espresso-soaked ladyfingers.", img: "tiramisu" },
  ],

  gelato: {
    signature: [
      ["Salted Caramel & Charcoal", "#2a2422", "#c98a3e"], ["Mango & Cream Cheese", "#f2b33d", "#fff2d6"],
      ["Filter Coffee", "#7b5236", "#e8d2b6"], ["Caramelised Pineapple", "#f0c24b", "#c97b2a"],
      ["Lotus Biscoff", "#c88a4e", "#f3e1c6"], ["Caramelised Banana", "#efd27a", "#a96a2e"],
      ["Honey Caramelised Peach", "#f4a675", "#e8b24a"],
    ],
    classic: [
      ["Coconut", "#f6f1e7", "#d9cbb3"], ["Pistachio", "#a9c46c", "#e9efd0"], ["Fior di Latte", "#fbf7ee", "#eae0cc"],
      ["Hazelnut", "#b88a5e", "#e9d3b7"], ["Chocolate", "#4b2a1e", "#8d5a3d"], ["Vanilla Bean", "#f5e7c4", "#3b2a1e"],
      ["Sapota (Chikoo)", "#a8774f", "#e2c4a1"], ["Strawberry", "#f08aa0", "#c4264a"], ["Jackfruit", "#f2c94c", "#e59a2c"],
    ],
    sorbet: [
      ["Mango", "#f7a928", "#ffd36b"], ["Peach", "#f7b089", "#f4885c"], ["Strawberry Mint", "#e8475f", "#7cc48a"],
      ["Pineapple", "#f5d547", "#a7c957"], ["Coco Colada", "#fdf6e3", "#f5d547"], ["Raw Mango & Chilli", "#c7d64f", "#d6402b"],
      ["Mango, Lime & Coconut Sundae", "#f7a928", "#b6d77a"],
    ],
  },

  chocolates: {
    truffles: [
      { id: "truffle-classic", name: "Traditional Chocolate Truffle", desc: "Silky ganache, cocoa-dusted, flaky salt.", img: "truffle-classic" },
      { id: "truffle-praline", name: "Praline Feuilletine Truffle", desc: "Hazelnut praline with crisp feuilletine.", img: "truffle-praline" },
    ],
    bonbons: [
      { id: "bonbon-caramel", name: "Sea Salt Caramel", desc: "Fleur de sel caramel in a dark shell.", img: "bonbon-caramel" },
      { id: "bonbon-almond", name: "Roasted Almond Praline", desc: "Roasted almond praline, amber shell.", img: "bonbon-almond" },
      { id: "bonbon-coconut", name: "Coconut", desc: "Toasted coconut ganache, white shell.", img: "bonbon-coconut" },
      { id: "bonbon-hazelnut", name: "Hazelnut Praline", desc: "Hazelnut praline over 811 ganache.", img: "bonbon-hazelnut" },
      { id: "bonbon-coffee", name: "Coffee Espresso", desc: "A liquid espresso centre. Bite carefully.", img: "bonbon-coffee" },
    ],
  },

  focaccia: [
    { id: "slab-garlic", name: "Roasted Garlic Chicken & Jalapeño", desc: "Garlic-butter chicken, triple cheese, jalapeños, Tabasco honey.", img: "slab-garlic", veg: false },
    { id: "slab-pepper", name: "Black Pepper Chicken & Charred Onion", desc: "Cracked pepper chicken, charred onion, garlic cream, curry leaf oil.", img: "slab-pepper", veg: false },
    { id: "slab-paneer", name: "Spicy Peri Peri Paneer", desc: "Charred paneer, onion jam, mint labneh, smoked paprika oil.", img: "slab-paneer", veg: true },
    { id: "slab-veg", name: "Mixed Vegetable Supreme", desc: "Seasonal vegetables, mozzarella, herb-infused olive oil.", img: "slab-veg", veg: true },
  ],

  kitchen: [
    { group: "Soups", items: [
      { name: "Roasted Chicken & Burnt Garlic Velouté", veg: false },
      { name: "Roasted Tomato & Charred Pepper", veg: true },
    ]},
    { group: "To begin", items: [
      { name: "Mushroom Arancini, Garlic Aioli", veg: true, img: "arancini" },
      { name: "Smoked Cheddar & Potato Croquettes, Sweet Chilli Jam", veg: true, img: "croquettes" },
      { name: "The Charred: Chicken & Smoked Cheese, Cold Honey-Lemon", veg: false, img: "charred-pizza" },
      { name: "The Charred: Paneer & Caramelised Onion, Roasted Garlic Cream", veg: true },
      { name: "Chargrilled Chicken Brochette, Honey-Mustard", veg: false, img: "brochette" },
      { name: "French Onion Mousse & Potato Crisps", veg: true, img: "onion-mousse" },
      { name: "Burrata & Hot Honey, Charred Sourdough", veg: true, img: "burrata" },
    ]},
    { group: "Mains", items: [
      { name: "Charcoal Risotto, Wild Mushroom, Parmesan Foam", veg: true, img: "risotto-charcoal" },
      { name: "Prawn Bisque Risotto, Aged Parmigiano Foam", veg: false, img: "risotto-prawn" },
      { name: "Chicken Parmigiana", veg: false, img: "parmigiana" },
      { name: "Roasted Vegetable Lasagna al Forno", veg: true, img: "lasagna" },
      { name: "Suprême de Volaille, White Wine Velouté", veg: false, img: "supreme" },
      { name: "Smoked & Fried Quail, BBQ Lacquer", veg: false, img: "quail" },
    ]},
    { group: "Outer coastal", items: [
      { name: "Pollo Asado Tacos", veg: false, img: "tacos" },
      { name: "Charred Corn Ribs, Smoked Brown Butter", veg: true },
      { name: "Original Fried Chicken Wings, Tabasco Honey", veg: false, img: "wings" },
      { name: "Tater Tots", veg: true },
    ]},
  ],
};
