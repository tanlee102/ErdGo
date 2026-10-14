-- Reporting warehouse star schema with sequences, facts, dimensions, and late ALTER FKs.
CREATE SEQUENCE [dw].[SalesSeq] AS BIGINT START WITH 1 INCREMENT BY 1;
CREATE SCHEMA [dw];
GO

CREATE TABLE [dw].[DimCustomer] (
    [CustomerKey] INT IDENTITY(1,1) NOT NULL,
    [CustomerCode] NVARCHAR(40) NOT NULL,
    [Email] NVARCHAR(256) NULL,
    [Segment] NVARCHAR(40) NOT NULL,
    CONSTRAINT [PK_DimCustomer] PRIMARY KEY ([CustomerKey]),
    CONSTRAINT [UQ_DimCustomer_Code] UNIQUE ([CustomerCode])
);
GO

CREATE TABLE [dw].[DimProduct] (
    [ProductKey] INT IDENTITY(1,1) NOT NULL,
    [Sku] NVARCHAR(80) NOT NULL,
    [Title] NVARCHAR(200) NOT NULL,
    [Category] NVARCHAR(80) NOT NULL,
    CONSTRAINT [PK_DimProduct] PRIMARY KEY ([ProductKey]),
    CONSTRAINT [UQ_DimProduct_Sku] UNIQUE ([Sku])
);
GO

CREATE TABLE [dw].[FactSales] (
    [SalesKey] BIGINT NOT NULL CONSTRAINT [DF_FactSales_Key] DEFAULT (NEXT VALUE FOR [dw].[SalesSeq]),
    [CustomerKey] INT NOT NULL,
    [ProductKey] INT NOT NULL,
    [OrderDateKey] INT NOT NULL,
    [Quantity] INT NOT NULL,
    [GrossAmount] DECIMAL(18,2) NOT NULL,
    [DiscountAmount] DECIMAL(18,2) NOT NULL DEFAULT ((0)),
    [NetAmount] AS ([GrossAmount] - [DiscountAmount]) PERSISTED,
    CONSTRAINT [PK_FactSales] PRIMARY KEY ([SalesKey])
);
GO

ALTER TABLE [dw].[FactSales]
    ADD CONSTRAINT [FK_FactSales_DimCustomer]
    FOREIGN KEY ([CustomerKey]) REFERENCES [dw].[DimCustomer] ([CustomerKey]);
ALTER TABLE [dw].[FactSales]
    ADD CONSTRAINT [FK_FactSales_DimProduct]
    FOREIGN KEY ([ProductKey]) REFERENCES [dw].[DimProduct] ([ProductKey]);

CREATE INDEX [IX_FactSales_CustomerDate] ON [dw].[FactSales] ([CustomerKey], [OrderDateKey]);
CREATE INDEX [IX_FactSales_ProductDate] ON [dw].[FactSales] ([ProductKey], [OrderDateKey]);
