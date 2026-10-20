-- Voted-out players on locked-in sessions were stored as "left"; they're "kicked" now (lobbies use it too).
-- Locked-in sessions never used "left" for anything else, so this only touches votes from the last release.
UPDATE "play_session_players" SET "status" = 'kicked'
WHERE "status" = 'left' AND "session_id" IN (SELECT "id" FROM "play_sessions" WHERE "kind" = 'planned');