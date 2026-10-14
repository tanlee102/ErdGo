CREATE TABLE [dbo].[Branches] (
    [BranchID] INT IDENTITY(10, 5) NOT NULL,
    [Code] CHAR(6) NOT NULL,
    [Name] NVARCHAR(120) NOT NULL,
    CONSTRAINT [PK_Branches] PRIMARY KEY CLUSTERED ([BranchID]),
    CONSTRAINT [UQ_Branches_Code] UNIQUE NONCLUSTERED ([Code])
);
GO

CREATE TABLE [dbo].[Customers] (
    [CustomerID] BIGINT IDENTITY(1000, 1) NOT NULL,
    [BranchID] INT NOT NULL,
    [Email] NVARCHAR(320),
    [FirstName] NVARCHAR(80) NOT NULL,
    [LastName] NVARCHAR(80) NOT NULL,
    [FullName] AS ([FirstName] + N' ' + [LastName]) PERSISTED NOT NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([CustomerID]),
    CONSTRAINT [UQ_Customers_Email] UNIQUE NONCLUSTERED ([Email]),
    CONSTRAINT [FK_Customers_Branch]
        FOREIGN KEY ([BranchID]) REFERENCES [dbo].[Branches]([BranchID])
);

CREATE TABLE [dbo].[Accounts] (
    [AccountID] BIGINT IDENTITY(5000, 10) NOT NULL,
    [CustomerID] BIGINT NOT NULL,
    [AccountNumber] NVARCHAR(34) NOT NULL,
    [Currency] CHAR(3) NOT NULL DEFAULT 'USD',
    [ClosedAt] DATETIME2 NULL,
    CONSTRAINT [PK_Accounts] PRIMARY KEY NONCLUSTERED ([AccountID]),
    CONSTRAINT [UQ_Accounts_Number] UNIQUE ([AccountNumber]),
    CONSTRAINT [FK_Accounts_Customer]
        FOREIGN KEY ([CustomerID]) REFERENCES [dbo].[Customers]([CustomerID])
);

CREATE NONCLUSTERED INDEX [IX_Accounts_Customer]
    ON [dbo].[Accounts] ([CustomerID], [AccountNumber])
    INCLUDE ([Currency])
    WHERE [ClosedAt] IS NULL;
