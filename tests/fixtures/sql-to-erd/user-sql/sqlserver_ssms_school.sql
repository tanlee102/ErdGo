-- SQL Server Management Studio script with GO batches, bracket identifiers, and WITH CHECK ALTER clauses.
SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO
IF OBJECT_ID('[dbo].[Enrollments]', 'U') IS NOT NULL DROP TABLE [dbo].[Enrollments];
IF OBJECT_ID('[dbo].[Students]', 'U') IS NOT NULL DROP TABLE [dbo].[Students];
IF OBJECT_ID('[dbo].[Schools]', 'U') IS NOT NULL DROP TABLE [dbo].[Schools];
GO

CREATE TABLE [dbo].[Schools] (
    [SchoolID] INT IDENTITY(1,1) NOT NULL,
    [Code] NVARCHAR(20) NOT NULL,
    [Name] NVARCHAR(200) NOT NULL,
    [CreatedAt] DATETIME2 NOT NULL CONSTRAINT [DF_Schools_CreatedAt] DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT [PK_Schools] PRIMARY KEY CLUSTERED ([SchoolID]),
    CONSTRAINT [UQ_Schools_Code] UNIQUE NONCLUSTERED ([Code])
) ON [PRIMARY];
GO

CREATE TABLE [dbo].[Students] (
    [StudentID] INT IDENTITY(1,1) NOT NULL,
    [SchoolID] INT NOT NULL,
    [StudentNo] NVARCHAR(40) NOT NULL,
    [FirstName] NVARCHAR(80) NOT NULL,
    [LastName] NVARCHAR(80) NOT NULL,
    [FullName] AS ([FirstName] + N' ' + [LastName]) PERSISTED,
    [IsActive] BIT NOT NULL CONSTRAINT [DF_Students_IsActive] DEFAULT ((1)),
    CONSTRAINT [PK_Students] PRIMARY KEY CLUSTERED ([StudentID]),
    CONSTRAINT [UQ_Students_School_No] UNIQUE NONCLUSTERED ([SchoolID], [StudentNo])
) TEXTIMAGE_ON [PRIMARY];
GO

CREATE TABLE [dbo].[Enrollments] (
    [EnrollmentID] BIGINT IDENTITY(1,1) NOT NULL,
    [StudentID] INT NOT NULL,
    [SchoolID] INT NOT NULL,
    [TermCode] NVARCHAR(20) NOT NULL,
    [Status] NVARCHAR(20) NOT NULL,
    [FinalGrade] DECIMAL(5,2) NULL,
    [CreatedAt] DATETIMEOFFSET NOT NULL,
    CONSTRAINT [PK_Enrollments] PRIMARY KEY NONCLUSTERED ([EnrollmentID])
);
GO

ALTER TABLE [dbo].[Students] WITH CHECK
    ADD CONSTRAINT [FK_Students_Schools]
    FOREIGN KEY([SchoolID]) REFERENCES [dbo].[Schools] ([SchoolID]);
GO
ALTER TABLE [dbo].[Enrollments] WITH CHECK
    ADD CONSTRAINT [FK_Enrollments_Students]
    FOREIGN KEY([StudentID]) REFERENCES [dbo].[Students] ([StudentID]);
GO
ALTER TABLE [dbo].[Enrollments] WITH CHECK
    ADD CONSTRAINT [FK_Enrollments_Schools]
    FOREIGN KEY([SchoolID]) REFERENCES [dbo].[Schools] ([SchoolID]);
GO

CREATE NONCLUSTERED INDEX [IX_Enrollments_Status]
    ON [dbo].[Enrollments] ([Status], [CreatedAt])
    INCLUDE ([FinalGrade])
    WHERE [Status] <> 'dropped';
GO
