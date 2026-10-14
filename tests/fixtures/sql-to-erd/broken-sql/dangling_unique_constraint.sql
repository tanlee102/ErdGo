CREATE TABLE customers (
    id INT PRIMARY KEY,
    email TEXT UNIQUE
);

CREATE TABLE orders (
    id INT PRIMARY KEY,
    customer_id INT,
    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
    CONSTRAINT uq_orders_external UNIQUE
);

CREATE TABLE invoices (
    id INT PRIMARY KEY,
    order_id INT REFERENCES orders(id)
);
