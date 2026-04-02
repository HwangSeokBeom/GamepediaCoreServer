WITH duplicate_nicknames AS (
  SELECT
    id,
    nickname,
    ROW_NUMBER() OVER (PARTITION BY nickname ORDER BY created_at ASC, id ASC) AS row_number
  FROM users
),
renamed_duplicates AS (
  SELECT
    id,
    nickname,
    row_number,
    LEFT(nickname, 41) || '_dup_' || SUBSTRING(REPLACE(id::text, '-', '') FROM 1 FOR 4) AS updated_nickname
  FROM duplicate_nicknames
  WHERE row_number > 1
)
UPDATE users
SET nickname = renamed_duplicates.updated_nickname
FROM renamed_duplicates
WHERE users.id = renamed_duplicates.id;

ALTER TABLE "users"
ADD CONSTRAINT "users_nickname_key" UNIQUE ("nickname");
