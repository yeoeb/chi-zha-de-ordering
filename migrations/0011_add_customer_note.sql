ALTER TABLE orders ADD COLUMN customer_note TEXT
	CHECK (
		customer_note IS NULL OR (
			typeof(customer_note) = 'text'
			AND customer_note = trim(customer_note)
			AND length(customer_note) BETWEEN 1 AND 120
		)
	);
