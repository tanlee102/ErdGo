CREATE TABLE [inv].[Warehouses] (
    [WarehouseID] INT IDENTITY(10,5) NOT NULL,
    [Code] NVARCHAR(20) NOT NULL,
    [Name] NVARCHAR(120) NOT NULL,
    CONSTRAINT [PK_Warehouses] PRIMARY KEY CLUSTERED ([WarehouseID]),
    CONSTRAINT [UQ_Warehouses_Code] UNIQUE ([Code])
);
GO

CREATE TABLE [inv].[Products] (
    [ProductID] BIGINT IDENTITY(100,1) NOT NULL,
    [Sku] NVARCHAR(64) NOT NULL,
    [Name] NVARCHAR(180) NOT NULL,
    [SearchName] AS (LOWER([Name])) PERSISTED,
    CONSTRAINT [PK_Products] PRIMARY KEY NONCLUSTERED ([ProductID]),
    CONSTRAINT [UQ_Products_Sku] UNIQUE ([Sku])
);

CREATE TABLE [inv].[Lots] (
    [WarehouseID] INT NOT NULL,
    [ProductID] BIGINT NOT NULL,
    [LotCode] NVARCHAR(64) NOT NULL,
    [ReceivedAt] DATETIME2 NOT NULL,
    [ExpiresAt] DATETIME2 NULL,
    CONSTRAINT [PK_Lots] PRIMARY KEY CLUSTERED ([WarehouseID], [ProductID], [LotCode]),
    CONSTRAINT [FK_Lots_Warehouse]
        FOREIGN KEY ([WarehouseID]) REFERENCES [inv].[Warehouses]([WarehouseID]),
    CONSTRAINT [FK_Lots_Product]
        FOREIGN KEY ([ProductID]) REFERENCES [inv].[Products]([ProductID])
);

CREATE TABLE [inv].[Movements] (
    [WarehouseID] INT NOT NULL,
    [ProductID] BIGINT NOT NULL,
    [LotCode] NVARCHAR(64) NOT NULL,
    [MovementID] BIGINT IDENTITY(1,1) NOT NULL,
    [DeltaQty] DECIMAL(14,3) NOT NULL,
    [Reason] NVARCHAR(40) NOT NULL DEFAULT 'manual',
    CONSTRAINT [PK_Movements] PRIMARY KEY NONCLUSTERED ([MovementID]),
    CONSTRAINT [FK_Movements_Lot]
        FOREIGN KEY ([WarehouseID], [ProductID], [LotCode])
        REFERENCES [inv].[Lots]([WarehouseID], [ProductID], [LotCode])
);

CREATE NONCLUSTERED INDEX [IX_Movements_Lot_Reason]
    ON [inv].[Movements] ([WarehouseID], [ProductID], [LotCode], [Reason]);
