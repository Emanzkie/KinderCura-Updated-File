-- ====================================================
-- KinderCura  –  New Features Schema (v4.0)
-- Run AFTER schema.sql and schema-fix-appointments.sql
-- Features: Video Attachments, Chat, Custom Questions
-- ====================================================

USE KinderCura;
GO

-- ─────────────────────────────────────────────────────
-- APPOINTMENT VIDEOS
-- Videos uploaded by parents during appointment booking
-- ─────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='appointment_videos' AND xtype='U')
CREATE TABLE appointment_videos (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    appointmentId INT NOT NULL FOREIGN KEY REFERENCES appointments(id) ON DELETE CASCADE,
    childId       INT NOT NULL FOREIGN KEY REFERENCES children(id),
    parentId      INT NOT NULL FOREIGN KEY REFERENCES users(id),
    filePath      NVARCHAR(500) NOT NULL,
    fileName      NVARCHAR(255) NOT NULL,
    fileSize      INT,
    mimeType      NVARCHAR(100),
    description   NVARCHAR(500),
    uploadedAt    DATETIME NOT NULL DEFAULT GETDATE()
);
GO

-- ─────────────────────────────────────────────────────
-- CHAT MESSAGES
-- Conversational chat between parent and pediatrician
-- Activated once appointment is approved OR child is
-- under a pediatrician's care.
-- ─────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='chat_messages' AND xtype='U')
CREATE TABLE chat_messages (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    appointmentId INT          FOREIGN KEY REFERENCES appointments(id),
    childId       INT NOT NULL FOREIGN KEY REFERENCES children(id),
    parentId      INT NOT NULL FOREIGN KEY REFERENCES users(id),
    pediatricianId INT NOT NULL FOREIGN KEY REFERENCES users(id),
    senderId      INT NOT NULL FOREIGN KEY REFERENCES users(id),
    senderRole    NVARCHAR(20) NOT NULL CHECK (senderRole IN ('parent','pediatrician')),
    message       NVARCHAR(MAX),
    videoPath     NVARCHAR(500),   -- optional video attachment in chat
    videoName     NVARCHAR(255),
    videoSize     INT,
    isRead        BIT NOT NULL DEFAULT 0,
    createdAt     DATETIME NOT NULL DEFAULT GETDATE()
);
GO

-- ─────────────────────────────────────────────────────
-- CUSTOM QUESTIONS  (pediatrician-created)
-- ─────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='custom_questions' AND xtype='U')
CREATE TABLE custom_questions (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    pediatricianId INT NOT NULL FOREIGN KEY REFERENCES users(id) ON DELETE CASCADE,
    questionText   NVARCHAR(500) NOT NULL,
    questionType   NVARCHAR(20)  NOT NULL
                   -- 'short_answer' retired: free-text answers don't fit assessment scoring.
                   CHECK (questionType IN ('yes_no','multiple_choice')),
    options        NVARCHAR(MAX),   -- JSON array of strings for multiple_choice
    domain         NVARCHAR(50),    -- Gross Motor | Fine Motor | Language | Personal-Social | Other
    ageMin         INT DEFAULT 0,   -- minimum child age (years) this applies to
    ageMax         INT DEFAULT 18,  -- maximum child age (years)
    isActive       BIT NOT NULL DEFAULT 1,
    createdAt      DATETIME NOT NULL DEFAULT GETDATE(),
    updatedAt      DATETIME NOT NULL DEFAULT GETDATE()
);
GO

-- ─────────────────────────────────────────────────────
-- CUSTOM QUESTION ASSIGNMENTS
-- Assigns a custom question to a specific appointment/child
-- ─────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='custom_question_assignments' AND xtype='U')
CREATE TABLE custom_question_assignments (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    questionId     INT NOT NULL FOREIGN KEY REFERENCES custom_questions(id) ON DELETE CASCADE,
    appointmentId  INT          FOREIGN KEY REFERENCES appointments(id),
    childId        INT NOT NULL FOREIGN KEY REFERENCES children(id),
    parentId       INT NOT NULL FOREIGN KEY REFERENCES users(id),
    answer         NVARCHAR(MAX),  -- the parent's answer (stored after parent answers)
    answeredAt     DATETIME,
    createdAt      DATETIME NOT NULL DEFAULT GETDATE()
);
GO

-- ─────────────────────────────────────────────────────
-- STATIC QUESTION ANSWERS
-- Stores parent responses to age-based static questions
-- ─────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='static_question_answers' AND xtype='U')
CREATE TABLE static_question_answers (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    childId        INT NOT NULL FOREIGN KEY REFERENCES children(id),
    appointmentId  INT          FOREIGN KEY REFERENCES appointments(id),
    pediatricianId INT          FOREIGN KEY REFERENCES users(id),
    questionId     INT NOT NULL,
    questionText   NVARCHAR(500),
    ageGroup       NVARCHAR(10),   -- "3" | "3.5-4" | "4" | "5" | "6" | "7-8"
    domain         NVARCHAR(50),
    answer         NVARCHAR(50),   -- "Yes, consistently" | "Sometimes" | "Not yet"
    answeredAt     DATETIME NOT NULL DEFAULT GETDATE()
);
GO

-- ─────────────────────────────────────────────────────
-- Update appointments table: add video_attached flag
-- (safe: only adds if column doesn't exist)
-- ─────────────────────────────────────────────────────
IF NOT EXISTS (
    SELECT * FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME='appointments' AND COLUMN_NAME='hasVideo'
)
ALTER TABLE appointments ADD hasVideo BIT NOT NULL DEFAULT 0;
GO

-- ─────────────────────────────────────────────────────
-- Update appointments table: add pedia_notifications support
-- (adds rejected status if not already there)
-- ─────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='pedia_notifications' AND xtype='U')
CREATE TABLE pedia_notifications (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    pediatricianId INT NOT NULL FOREIGN KEY REFERENCES users(id),
    appointmentId  INT          FOREIGN KEY REFERENCES appointments(id),
    parentName     NVARCHAR(200),
    childName      NVARCHAR(200),
    appointmentDate DATE,
    appointmentTime NVARCHAR(20),
    reason         NVARCHAR(200),
    hasVideo       BIT DEFAULT 0,
    status         NVARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','declined')),
    createdAt      DATETIME NOT NULL DEFAULT GETDATE()
);
GO


-- ─────────────────────────────────────────────────────
-- Add hasVideo to pedia_notifications if missing
-- (table may already exist from schema-update.sql)
-- ─────────────────────────────────────────────────────
IF NOT EXISTS (
    SELECT * FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME='pedia_notifications' AND COLUMN_NAME='hasVideo'
)
ALTER TABLE pedia_notifications ADD hasVideo BIT NOT NULL DEFAULT 0;
GO

PRINT '✅  KinderCura v4.0 new features schema applied successfully.';
GO
