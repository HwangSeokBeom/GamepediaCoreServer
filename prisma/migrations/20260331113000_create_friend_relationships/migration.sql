CREATE TYPE "FriendRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELED');

CREATE TABLE "friend_requests" (
    "id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID NOT NULL,
    "status" "FriendRequestStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "friend_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "friendships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "friend_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "friend_requests_from_user_id_status_created_at_idx" ON "friend_requests"("from_user_id", "status", "created_at");
CREATE INDEX "friend_requests_to_user_id_status_created_at_idx" ON "friend_requests"("to_user_id", "status", "created_at");
CREATE UNIQUE INDEX "friendships_user_id_friend_user_id_key" ON "friendships"("user_id", "friend_user_id");
CREATE INDEX "friendships_user_id_created_at_idx" ON "friendships"("user_id", "created_at");
CREATE INDEX "friendships_friend_user_id_created_at_idx" ON "friendships"("friend_user_id", "created_at");

ALTER TABLE "friend_requests"
ADD CONSTRAINT "friend_requests_from_user_id_fkey"
FOREIGN KEY ("from_user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "friend_requests"
ADD CONSTRAINT "friend_requests_to_user_id_fkey"
FOREIGN KEY ("to_user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "friendships"
ADD CONSTRAINT "friendships_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "friendships"
ADD CONSTRAINT "friendships_friend_user_id_fkey"
FOREIGN KEY ("friend_user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
