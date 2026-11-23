-- GST for one item when it differs from its section (e.g. a packed chocolate sold as goods): {"hsn":"1806","rate":5}
ALTER TABLE products ADD COLUMN tax TEXT NOT NULL DEFAULT '';
