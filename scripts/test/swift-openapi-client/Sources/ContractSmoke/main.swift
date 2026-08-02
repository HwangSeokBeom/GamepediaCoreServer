import Foundation
import OpenAPIRuntime

// These references make the gate prove that the server-to-iOS path generates
// the concrete article and every key-specific Today type.
_ = Components.Schemas.ArticleSummary.self
_ = Components.Schemas.TodayFeed.self
_ = Components.Schemas.TodaySection.self
_ = Components.Schemas.TodayPlayCompassData.self
_ = Components.Schemas.TodayGameDnaData.self
_ = Components.Schemas.TodayGameBriefingData.self
_ = Components.Schemas.TodayBacklogRescueData.self
_ = Components.Schemas.TodaySpoilerFreeStartGuideData.self
_ = Components.Schemas.TodayEditorialCurationData.self
_ = Components.Schemas.TodayMonthlyReplayData.self
_ = Components.Schemas.TodayFriendActivityData.self
_ = Components.Schemas.PlayCompassRecommendation.self
_ = Components.Schemas.PlayCompassDataFreshness.self
_ = Client.self

// Decode every successful key-specific section. The editorial branch reaches
// ArticleSummary (including required nulls); a second fixture below proves the
// unavailable/disabled branch keeps its required null data value.
let todayFixture = #"""
{
  "generatedAt": "2026-07-30T00:00:00Z",
  "timezone": "UTC",
  "locale": null,
  "sections": [
    {
      "key": "playCompass",
      "status": "ok",
      "reasonCode": null,
      "data": {
        "recommendations": [],
        "confidence": "LOW",
        "dataFreshness": {
          "candidatePoolSize": 0,
          "freshestLibraryUpdateAt": null,
          "playlogSampleSize": 0,
          "stale": true
        },
        "emptyReason": "no_owned_playing_or_backlog_games",
        "ownedOnly": true
      }
    },
    {
      "key": "gameDNA",
      "status": "ok",
      "reasonCode": null,
      "data": {
        "signalCount": 0,
        "confidence": "LOW",
        "generatedAt": "2026-07-30T00:00:00Z",
        "topGenres": [],
        "sessionLengthLabel": "UNKNOWN",
        "socialLabel": "BALANCED",
        "toneLabel": "BALANCED",
        "missingSignals": [],
        "reasonCodes": []
      }
    },
    {
      "key": "gameBriefing",
      "status": "ok",
      "reasonCode": null,
      "data": {
        "items": [],
        "emptyReason": "no_followed_or_playing_games",
        "generatedAt": "2026-07-30T00:00:00Z"
      }
    },
    {
      "key": "backlogRescue",
      "status": "ok",
      "reasonCode": null,
      "data": {
        "items": [],
        "emptyReason": "no_backlog_entries"
      }
    },
    {
      "key": "spoilerFreeStartGuide",
      "status": "ok",
      "reasonCode": null,
      "data": {
        "items": [],
        "emptyReason": "no_startable_games"
      }
    },
    {
      "key": "editorialCuration",
      "status": "ok",
      "reasonCode": null,
      "data": {
        "articles": [
          {
            "slug": "contract-smoke",
            "status": "PUBLISHED",
            "locale": "en",
            "headline": "Generated client smoke",
            "excerpt": "A fixture decoded by the generated Swift type.",
            "publishedAt": "2026-07-30T00:00:00Z",
            "correctedAt": null,
            "heroImage": null,
            "heroImageWithheldReason": "no_eligible_hero",
            "relatedGames": [],
            "sourceCount": 0
          }
        ],
        "emptyReason": null
      }
    },
    {
      "key": "monthlyReplay",
      "status": "ok",
      "reasonCode": null,
      "data": {
        "monthKey": "2026-07",
        "timezone": "UTC",
        "isEmpty": true,
        "playedDayCount": 0,
        "totalMinutes": 0,
        "mostPlayedGame": null,
        "surpriseGame": null,
        "missingData": []
      }
    },
    {
      "key": "friendActivity",
      "status": "ok",
      "reasonCode": null,
      "data": {
        "items": [],
        "emptyReason": "no_friends"
      }
    }
  ],
  "meta": {
    "sectionOrder": [
      "playCompass",
      "gameDNA",
      "gameBriefing",
      "backlogRescue",
      "spoilerFreeStartGuide",
      "editorialCuration",
      "monthlyReplay",
      "friendActivity"
    ],
    "limit": 8,
    "nextCursor": null,
    "partialFailure": false
  }
}
"""#

let decoder = JSONDecoder()
decoder.dateDecodingStrategy = .iso8601
_ = try decoder.decode(
    Components.Schemas.TodayFeed.self,
    from: Data(todayFixture.utf8)
)

let unavailableFixture = #"""
{
  "generatedAt": "2026-07-30T00:00:00Z",
  "timezone": "UTC",
  "locale": null,
  "sections": [
    {
      "key": "playCompass",
      "status": "disabled",
      "reasonCode": "feature_disabled:playCompass",
      "data": null
    }
  ],
  "meta": {
    "sectionOrder": [
      "playCompass",
      "gameDNA",
      "gameBriefing",
      "backlogRescue",
      "spoilerFreeStartGuide",
      "editorialCuration",
      "monthlyReplay",
      "friendActivity"
    ],
    "limit": 1,
    "nextCursor": null,
    "partialFailure": false
  }
}
"""#

_ = try decoder.decode(
    Components.Schemas.TodayFeed.self,
    from: Data(unavailableFixture.utf8)
)

// ---------------------------------------------------------------------------
// Quick-add submissions and pagination
// ---------------------------------------------------------------------------
//
// These four operations used to answer with the generic SuccessEnvelope and an
// untyped `data`/`meta`, so a generated client could reach neither the confirmed
// catalogGameId, nor the submission's resolution, nor either cursor. Referencing
// the concrete types here makes that reachability a build failure if it regresses.

_ = Components.Schemas.SubmissionConfirmEnvelope.self
_ = Components.Schemas.SubmissionConfirmResult.self
_ = Components.Schemas.SubmissionIdentityConflict.self
_ = Components.Schemas.SubmissionStateEnvelope.self
_ = Components.Schemas.SubmissionState.self
_ = Components.Schemas.SubmissionGameDraft.self
_ = Components.Schemas.SubmissionCandidateSummary.self
_ = Components.Schemas.GameSubmissionStatus.self
_ = Components.Schemas.GameSubmissionInputType.self
_ = Components.Schemas.CatalogSearchEnvelope.self
_ = Components.Schemas.CatalogSearchMeta.self
_ = Components.Schemas.PlaySessionListEnvelope.self
_ = Components.Schemas.PlaySessionListMeta.self

// Every fixture below is a verbatim response captured from the running server
// against a real PostgreSQL, not a hand-written approximation.

// 201: a new PRIVATE canonical game was created.
let confirmCreatedFixture = #"""
{
  "success": true,
  "data": {
    "submissionId": "2df473b2-00a3-493d-9441-b67a8886edca",
    "status": "PERSONAL_CONFIRMED",
    "catalogGameId": "8fbb3f58-aaa8-482a-9463-77dd741fc049",
    "createdNewGame": true,
    "idempotentReplay": false,
    "publicReviewStatus": "PRIVATE",
    "identityConflict": null
  }
}
"""#

let confirmCreated = try decoder.decode(
    Components.Schemas.SubmissionConfirmEnvelope.self,
    from: Data(confirmCreatedFixture.utf8)
)

// The whole point of the change: the catalog game id is reachable as a typed value.
precondition(confirmCreated.data.catalogGameId == "8fbb3f58-aaa8-482a-9463-77dd741fc049")
precondition(confirmCreated.data.createdNewGame)
precondition(confirmCreated.data.status == .PERSONAL_CONFIRMED)
precondition(confirmCreated.data.publicReviewStatus == .PRIVATE)
precondition(confirmCreated.data.identityConflict == nil)

// 200 replay, with the identity conflict populated and a null catalog game id —
// both states a real server produced.
let confirmReplayFixture = #"""
{
  "success": true,
  "data": {
    "submissionId": "ce81641b-2500-4b24-953e-28c0e9689e2d",
    "status": "PENDING_REVIEW",
    "catalogGameId": null,
    "createdNewGame": false,
    "idempotentReplay": true,
    "publicReviewStatus": "PENDING_REVIEW",
    "identityConflict": {
      "provider": "STEAM",
      "existingCatalogGameId": "86b7f5fc-6834-48e1-bd4d-ce5a386b9fc5",
      "reasonCode": "verified_identity_already_exists"
    }
  }
}
"""#

let confirmReplay = try decoder.decode(
    Components.Schemas.SubmissionConfirmEnvelope.self,
    from: Data(confirmReplayFixture.utf8)
)

precondition(confirmReplay.data.catalogGameId == nil)
precondition(confirmReplay.data.idempotentReplay)
precondition(confirmReplay.data.identityConflict?.provider == .STEAM)
precondition(confirmReplay.data.identityConflict?.existingCatalogGameId == "86b7f5fc-6834-48e1-bd4d-ce5a386b9fc5")

// A fully populated submission: status, resolution and the resulting catalog game.
let submissionStateFixture = #"""
{
  "success": true,
  "data": {
    "submissionId": "2df473b2-00a3-493d-9441-b67a8886edca",
    "status": "PERSONAL_CONFIRMED",
    "inputType": "TEXT",
    "locale": "ko",
    "regionCode": "KR",
    "platformHint": null,
    "newGameDraft": {
      "originalTitle": "Wire Capture Game",
      "requiresTitleConfirmation": false,
      "developerName": "Capture Studio",
      "publisherName": "Capture Publishing",
      "firstReleaseDate": "2024-05-01",
      "genres": ["Action"],
      "platforms": ["STEAM"],
      "supportsSinglePlayer": true,
      "supportsMultiplayer": false,
      "typicalSessionMinutes": 45,
      "localizations": [
        {
          "kind": "ORIGINAL_TITLE",
          "languageCode": "en",
          "regionCode": null,
          "title": "Wire Capture Game"
        }
      ],
      "regionalReleases": [
        {
          "countryCode": "KR",
          "languageCode": "ko",
          "platform": "STEAM",
          "operatorName": null,
          "serverRegion": null,
          "releaseDate": "2024-05-01",
          "shutdownDate": null,
          "serviceStatus": "LIVE"
        }
      ],
      "identities": [],
      "fieldProvenance": [
        {
          "fieldPath": "originalTitle",
          "provenance": "AI_INFERRED",
          "confidence": 0.8
        }
      ]
    },
    "draftReadable": true,
    "candidateSummary": null,
    "clarifyingQuestions": [],
    "aiFallbackUsed": false,
    "catalogGameId": "8fbb3f58-aaa8-482a-9463-77dd741fc049",
    "publicReviewStatus": "PRIVATE",
    "expiresAt": "2026-07-31T08:28:00.785Z",
    "expired": false,
    "createdAt": "2026-07-31T07:28:00.786Z",
    "updatedAt": "2026-07-31T07:28:00.836Z"
  }
}
"""#

let submissionState = try decoder.decode(
    Components.Schemas.SubmissionStateEnvelope.self,
    from: Data(submissionStateFixture.utf8)
)

precondition(submissionState.data.status == .PERSONAL_CONFIRMED)
precondition(submissionState.data.inputType == .TEXT)
precondition(submissionState.data.draftReadable)
precondition(submissionState.data.catalogGameId == "8fbb3f58-aaa8-482a-9463-77dd741fc049")
precondition(submissionState.data.newGameDraft?.originalTitle == "Wire Capture Game")
precondition(submissionState.data.newGameDraft?.localizations.first?.kind == .ORIGINAL_TITLE)
precondition(submissionState.data.newGameDraft?.regionalReleases.first?.serviceStatus == .LIVE)
precondition(submissionState.data.newGameDraft?.fieldProvenance.first?.provenance == .AI_INFERRED)

// A submission whose stored draft no longer validates: the optional draft fields
// are absent rather than null, and candidateSummary carries its own shape.
let unreadableSubmissionFixture = #"""
{
  "success": true,
  "data": {
    "submissionId": "2ed6ea24-93ee-4d77-87d1-e6a86e7f5274",
    "status": "PREVIEW",
    "inputType": "URL",
    "locale": "ko",
    "regionCode": "KR",
    "platformHint": "STEAM",
    "newGameDraft": null,
    "draftReadable": false,
    "candidateSummary": {
      "version": 1,
      "candidateCount": 2,
      "catalogGameIds": ["86b7f5fc-6834-48e1-bd4d-ce5a386b9fc5"],
      "reasonCodes": ["normalized_title_exact"]
    },
    "clarifyingQuestions": ["Which platform did you play it on?"],
    "aiFallbackUsed": true,
    "catalogGameId": null,
    "publicReviewStatus": "PRIVATE",
    "expiresAt": "2026-07-31T07:27:59.893Z",
    "expired": true,
    "createdAt": "2026-07-31T07:28:00.893Z",
    "updatedAt": "2026-07-31T07:28:00.893Z"
  }
}
"""#

let unreadableSubmission = try decoder.decode(
    Components.Schemas.SubmissionStateEnvelope.self,
    from: Data(unreadableSubmissionFixture.utf8)
)

precondition(unreadableSubmission.data.newGameDraft == nil)
precondition(!unreadableSubmission.data.draftReadable)
precondition(unreadableSubmission.data.expired)
precondition(unreadableSubmission.data.candidateSummary?.candidateCount == 2)
precondition(unreadableSubmission.data.clarifyingQuestions.count == 1)

// A minimal draft: every optional field omitted, which is what the server emits
// when the extractor produced nothing for them.
let minimalDraftFixture = #"""
{
  "success": true,
  "data": {
    "submissionId": "027c8653-cfa3-4eb8-b77b-8b64ddf33d3c",
    "status": "PREVIEW",
    "inputType": "TEXT",
    "locale": "ko",
    "regionCode": "KR",
    "platformHint": null,
    "newGameDraft": {
      "originalTitle": "Minimal Wire Game",
      "requiresTitleConfirmation": false,
      "genres": [],
      "platforms": [],
      "localizations": [],
      "regionalReleases": [],
      "identities": [],
      "fieldProvenance": []
    },
    "draftReadable": true,
    "candidateSummary": null,
    "clarifyingQuestions": [],
    "aiFallbackUsed": false,
    "catalogGameId": null,
    "publicReviewStatus": "PRIVATE",
    "expiresAt": "2026-07-31T08:28:00.889Z",
    "expired": false,
    "createdAt": "2026-07-31T07:28:00.890Z",
    "updatedAt": "2026-07-31T07:28:00.890Z"
  }
}
"""#

let minimalDraft = try decoder.decode(
    Components.Schemas.SubmissionStateEnvelope.self,
    from: Data(minimalDraftFixture.utf8)
)

precondition(minimalDraft.data.newGameDraft?.developerName == nil)
precondition(minimalDraft.data.newGameDraft?.typicalSessionMinutes == nil)
precondition(minimalDraft.data.newGameDraft?.genres.isEmpty == true)

// Catalog search: a page with a cursor, then the last page without one.
let searchFirstPageFixture = #"""
{
  "success": true,
  "data": {
    "games": [
      {
        "catalogGameId": "8fbb3f58-aaa8-482a-9463-77dd741fc049",
        "originalTitle": "Paged Search Title 0",
        "slug": null,
        "developerName": null,
        "publisherName": null,
        "firstReleaseDate": null,
        "genres": [],
        "platforms": [],
        "publicationStatus": "PUBLISHED",
        "titleProvenance": "EDITOR_VERIFIED",
        "identities": [],
        "matchScore": 1.0
      }
    ],
    "meta": {
      "limit": 2,
      "nextCursor": "eyJ2IjoxLCJvIjoyfQ",
      "matchedBy": "ranked",
      "totalScanned": 3
    }
  }
}
"""#

let searchFirstPage = try decoder.decode(
    Components.Schemas.CatalogSearchEnvelope.self,
    from: Data(searchFirstPageFixture.utf8)
)

precondition(searchFirstPage.data.meta.nextCursor == "eyJ2IjoxLCJvIjoyfQ")
precondition(searchFirstPage.data.meta.matchedBy == .ranked)
precondition(searchFirstPage.data.meta.totalScanned == 3)
precondition(searchFirstPage.data.games.first?.matchScore == 1.0)

let searchLastPageFixture = #"""
{
  "success": true,
  "data": {
    "games": [],
    "meta": {
      "limit": 20,
      "nextCursor": null,
      "matchedBy": "no_match",
      "totalScanned": 0
    }
  }
}
"""#

let searchLastPage = try decoder.decode(
    Components.Schemas.CatalogSearchEnvelope.self,
    from: Data(searchLastPageFixture.utf8)
)

precondition(searchLastPage.data.meta.nextCursor == nil)
precondition(searchLastPage.data.meta.matchedBy == .no_match)

// Playlog: the typed keyset cursor the iOS calendar derives its sessions from.
let playSessionPageFixture = #"""
{
  "success": true,
  "data": {
    "playSessions": [
      {
        "id": "0133436d-057d-4a74-b0c5-549543e3c4e3",
        "catalogGameId": "326474cc-b6cd-4b07-a225-683c4370100a",
        "regionalReleaseId": null,
        "playedAt": "2026-06-12T10:00:00.000Z",
        "durationMinutes": 32,
        "progressPercent": null,
        "mood": null,
        "note": null,
        "outcome": "CONTINUE",
        "visibility": "PRIVATE",
        "provenance": "USER_CONFIRMED",
        "clientMutationId": "wire-session-2",
        "createdAt": "2026-07-31T07:28:00.942Z",
        "updatedAt": "2026-07-31T07:28:00.942Z"
      }
    ],
    "meta": {
      "limit": 2,
      "nextCursor": "eyJ2IjoxLCJwIjoiMjAyNi0wNi0xMVQxMDowMDowMC4wMDBaIiwiaSI6IjRiN2EwNjBhLTgzMjUtNGQ2Mi1hOGY5LTE3OTY2ZDAzMGE0ZCJ9"
    }
  }
}
"""#

let playSessionPage = try decoder.decode(
    Components.Schemas.PlaySessionListEnvelope.self,
    from: Data(playSessionPageFixture.utf8)
)

precondition(playSessionPage.data.meta.limit == 2)
precondition(playSessionPage.data.meta.nextCursor?.isEmpty == false)
precondition(playSessionPage.data.playSessions.first?.outcome == .CONTINUE)

let playSessionLastPageFixture = #"""
{
  "success": true,
  "data": {
    "playSessions": [],
    "meta": {
      "limit": 20,
      "nextCursor": null
    }
  }
}
"""#

let playSessionLastPage = try decoder.decode(
    Components.Schemas.PlaySessionListEnvelope.self,
    from: Data(playSessionLastPageFixture.utf8)
)

precondition(playSessionLastPage.data.meta.nextCursor == nil)
precondition(playSessionLastPage.data.playSessions.isEmpty)
