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
