import { redis } from "./redis";

export async function invalidateLeaderboardCache(): Promise<void> {
  const keys = await redis.keys("leaderboard:*");
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export async function invalidateChallengesCache(): Promise<void> {
  const keys = await redis.keys("challenges:active:*");
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
