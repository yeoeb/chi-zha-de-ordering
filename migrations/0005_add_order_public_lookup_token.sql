ALTER TABLE orders ADD COLUMN public_lookup_token TEXT;

UPDATE orders
SET public_lookup_token = lower(hex(randomblob(32)))
WHERE public_lookup_token IS NULL;

CREATE UNIQUE INDEX orders_public_lookup_token_unique
	ON orders (public_lookup_token);

CREATE TRIGGER orders_public_lookup_token_insert_guard
BEFORE INSERT ON orders
WHEN
	NEW.public_lookup_token IS NULL
	OR length(NEW.public_lookup_token) <> 64
	OR NEW.public_lookup_token GLOB '*[^0-9a-f]*'
BEGIN
	SELECT RAISE(ABORT, 'invalid public lookup token');
END;

CREATE TRIGGER orders_public_lookup_token_immutable
BEFORE UPDATE OF public_lookup_token ON orders
WHEN NEW.public_lookup_token IS NOT OLD.public_lookup_token
BEGIN
	SELECT RAISE(ABORT, 'public lookup token is immutable');
END;
