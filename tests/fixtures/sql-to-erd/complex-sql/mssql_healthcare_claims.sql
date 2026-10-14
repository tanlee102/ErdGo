CREATE TABLE [care].[Facilities] (
    [FacilityID] INT IDENTITY(1,1) NOT NULL,
    [Code] NVARCHAR(30) NOT NULL,
    [Name] NVARCHAR(160) NOT NULL,
    CONSTRAINT [PK_Facilities] PRIMARY KEY CLUSTERED ([FacilityID]),
    CONSTRAINT [UQ_Facilities_Code] UNIQUE NONCLUSTERED ([Code])
);
GO

CREATE TABLE [care].[Patients] (
    [PatientID] BIGINT IDENTITY(1000,1) NOT NULL,
    [FacilityID] INT NOT NULL,
    [ExternalMRN] NVARCHAR(80) NOT NULL,
    [FirstName] NVARCHAR(80) NOT NULL,
    [LastName] NVARCHAR(80) NOT NULL,
    [FullName] AS ([FirstName] + N' ' + [LastName]) PERSISTED NOT NULL,
    CONSTRAINT [PK_Patients] PRIMARY KEY NONCLUSTERED ([PatientID]),
    CONSTRAINT [UQ_Patients_MRN] UNIQUE ([FacilityID], [ExternalMRN]),
    CONSTRAINT [FK_Patients_Facility]
        FOREIGN KEY ([FacilityID]) REFERENCES [care].[Facilities]([FacilityID])
);

CREATE TABLE [care].[Encounters] (
    [EncounterID] BIGINT IDENTITY(5000,1) NOT NULL,
    [PatientID] BIGINT NOT NULL,
    [FacilityID] INT NOT NULL,
    [StartedAt] DATETIME2 NOT NULL,
    [EndedAt] DATETIME2 NULL,
    [Status] NVARCHAR(20) NOT NULL DEFAULT 'open',
    [DurationMinutes] AS (DATEDIFF(minute, [StartedAt], [EndedAt])) PERSISTED,
    CONSTRAINT [PK_Encounters] PRIMARY KEY CLUSTERED ([EncounterID]),
    CONSTRAINT [FK_Encounters_Patient]
        FOREIGN KEY ([PatientID]) REFERENCES [care].[Patients]([PatientID]),
    CONSTRAINT [FK_Encounters_Facility]
        FOREIGN KEY ([FacilityID]) REFERENCES [care].[Facilities]([FacilityID])
);

CREATE TABLE [care].[Claims] (
    [ClaimID] BIGINT IDENTITY(9000,1) NOT NULL,
    [EncounterID] BIGINT NOT NULL,
    [ClaimNumber] NVARCHAR(80) NOT NULL,
    [BilledAmount] DECIMAL(14,2) NOT NULL,
    [PaidAmount] DECIMAL(14,2) NOT NULL DEFAULT 0,
    [Balance] AS ([BilledAmount] - [PaidAmount]) PERSISTED,
    CONSTRAINT [PK_Claims] PRIMARY KEY CLUSTERED ([ClaimID]),
    CONSTRAINT [UQ_Claims_Number] UNIQUE ([ClaimNumber]),
    CONSTRAINT [FK_Claims_Encounter]
        FOREIGN KEY ([EncounterID]) REFERENCES [care].[Encounters]([EncounterID])
);

CREATE NONCLUSTERED INDEX [IX_Encounters_Status]
    ON [care].[Encounters] ([FacilityID], [Status])
    INCLUDE ([StartedAt], [EndedAt])
    WHERE [Status] <> 'closed';
