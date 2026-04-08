# Review Comments API

## 1. .pen interpretation

Reference file: `/Users/hwangseokbeom/Documents/gamepediaReview.pen`

Relevant screens and notes:
- `리뷰 상세 - 댓글 (Populated)`
- `리뷰 상세 - 댓글 없음 (Empty)`
- `리뷰 상세 - 답글 입력 (Reply Input)`
- `내 댓글 액션시트 (My Comment)`
- `다른 사람 댓글 액션시트 (Other Comment)`
- `flowNote2`

Server-side requirements derived from the design:
- Top-level comments and 1-depth replies must be distinguishable.
- Replying to a reply still stays in the same reply level and needs reply target context.
- Review detail needs comment count, reply preview, reply toggle cursor, author summary, and my-action flags.
- Comment action sheet differs by ownership:
  - mine: reply, edit, delete
  - others: reply, report
- Reaction UI is currently heart-first, but the API supports `like`, `dislike`, and reaction cancel.
- The `.pen` file does not include a dedicated "my comments" screen, so `/users/me/comments` includes review context for profile use.

## 2. Prisma schema and migration

Schema:
- `ReviewCommentReactionType` enum: [prisma/schema.prisma](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/prisma/schema.prisma#L35)
- `ReviewComment` model: [prisma/schema.prisma](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/prisma/schema.prisma#L150)
- `ReviewCommentReaction` model: [prisma/schema.prisma](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/prisma/schema.prisma#L177)
- `ReviewCommentReport` model: [prisma/schema.prisma](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/prisma/schema.prisma#L193)

Migration:
- [migration.sql](/Users/hwangseokbeom/Documents/GitHub/GamePediaCoreServer/prisma/migrations/20260405093000_add_review_comment_discussions/migration.sql)

Notes:
- `parent_comment_id` stores the thread root for replies.
- `reply_to_comment_id` stores the direct reply target for mention-style UI.
- `depth` is limited in practice to `0` or `1`.
- delete policy is soft delete via `is_deleted` + `deleted_at`.
- reactions are unique per `(comment_id, user_id)`.

## 3. Primary endpoints

Recommended endpoints for the iOS client:
- `GET /reviews/:reviewId/comments`
- `POST /reviews/:reviewId/comments`
- `GET /reviews/:reviewId/comments/:commentId/replies`
- `PATCH /reviews/:reviewId/comments/:commentId`
- `DELETE /reviews/:reviewId/comments/:commentId`
- `POST /reviews/:reviewId/comments/:commentId/reactions`
- `DELETE /reviews/:reviewId/comments/:commentId/reactions`
- `POST /reviews/:reviewId/comments/:commentId/report`
- `GET /users/me/comments`

Backward-compatible aliases are also left in place under `/review-comments/:commentId/...`.

## 4. Request / response examples

### GET /reviews/:reviewId/comments

Query:
```json
{
  "limit": 20,
  "repliesLimit": 3,
  "sort": "latest"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "review": {
      "id": "review-uuid",
      "gameId": "igdb-12345",
      "authorId": "user-uuid"
    },
    "comments": [
      {
        "id": "comment-uuid",
        "reviewId": "review-uuid",
        "parentCommentId": null,
        "replyToCommentId": null,
        "content": "이 리뷰 덕분에 구매 결정했어요!",
        "isDeleted": false,
        "createdAt": "2026-04-06T03:00:00.000Z",
        "updatedAt": "2026-04-06T03:05:00.000Z",
        "isEdited": true,
        "likeCount": 4,
        "dislikeCount": 1,
        "myReaction": "like",
        "replyCount": 2,
        "author": {
          "id": "user-uuid",
          "nickname": "김민수",
          "profileImageUrl": "https://..."
        },
        "isMine": false,
        "isReviewAuthor": false,
        "replies": []
      }
    ],
    "meta": {
      "limit": 20,
      "sort": "latest",
      "nextCursor": null,
      "topLevelCommentCount": 4,
      "commentCount": 8,
      "totalTopLevelCount": 4,
      "totalCommentCount": 8
    }
  }
}
```

### POST /reviews/:reviewId/comments

Top-level:
```json
{
  "content": "댓글을 남깁니다."
}
```

Reply:
```json
{
  "content": "답글을 남깁니다.",
  "parentCommentId": "comment-uuid"
}
```

### PATCH /reviews/:reviewId/comments/:commentId

```json
{
  "content": "수정된 댓글 내용입니다."
}
```

### POST /reviews/:reviewId/comments/:commentId/reactions

```json
{
  "reactionType": "like"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "commentId": "comment-uuid",
    "myReaction": "like",
    "isLiked": true,
    "likeCount": 5,
    "dislikeCount": 1,
    "reactions": {
      "likeCount": 5,
      "dislikeCount": 1,
      "myReaction": "like"
    }
  }
}
```

### DELETE /reviews/:reviewId/comments/:commentId/reactions

Response:
```json
{
  "success": true,
  "data": {
    "commentId": "comment-uuid",
    "myReaction": null,
    "isLiked": false,
    "likeCount": 4,
    "dislikeCount": 1,
    "reactions": {
      "likeCount": 4,
      "dislikeCount": 1,
      "myReaction": null
    }
  }
}
```

### GET /users/me/comments

Response item shape:
```json
{
  "id": "comment-uuid",
  "reviewId": "review-uuid",
  "parentCommentId": null,
  "content": null,
  "isDeleted": true,
  "isEdited": false,
  "likeCount": 2,
  "dislikeCount": 0,
  "myReaction": null,
  "author": {
    "id": "me",
    "nickname": "이현우",
    "profileImageUrl": "https://..."
  },
  "review": {
    "id": "review-uuid",
    "gameId": "igdb-12345",
    "authorId": "review-author-uuid",
    "author": {
      "id": "review-author-uuid",
      "nickname": "리뷰작성자",
      "profileImageUrl": "https://..."
    },
    "rating": 4.5,
    "contentPreview": "첫 플레이 후기. 오픈월드의 자유도가 인상적이고..."
  }
}
```

## 5. Permission and exception policy

- Authentication is required for every comment endpoint.
- Only the author of a comment can edit or delete it.
- `COMMENT_REVIEW_MISMATCH` is returned when `reviewId` and `commentId` do not match.
- `COMMENT_PARENT_DELETED` is returned when trying to reply to a deleted comment.
- Deleted comments stay readable as tombstones with `isDeleted: true` and `content: null`.
- Parent comments with replies are not hard-deleted; replies remain attached to the soft-deleted parent.
- Reaction uniqueness is enforced by the database and by service-level lookup/update flow.

## 6. Client integration notes

- Use `commentCount` for the badge in the review detail header.
- Use `replyCount`, `replies`, and `repliesNextCursor` for the reply toggle UI.
- Use `replyTo` when rendering reply-to-reply mention context.
- Use `isMine`, `isReviewAuthor`, and `availableActions` to branch UI state.
- Use `isEdited` instead of comparing timestamps on the client.
- Use `/users/me/comments` for the profile screen; it already includes minimal review context.

## 7. Test points

- Create top-level comment.
- Create reply from top-level comment.
- Create reply from an existing reply and verify `parentCommentId` stays on the thread root.
- Update only own comment.
- Delete own comment with and without replies.
- React with `like`, switch to `dislike`, then cancel.
- Fetch review comments and verify `commentCount`, `replyCount`, `myReaction`, `isEdited`.
- Fetch my comments and verify deleted comments are still returned with review context.
