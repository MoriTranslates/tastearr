import { verdicts } from "../server/data/feedback.js";

/** The verdict stored for one AniList id, for assertions. */
export const feedbackFor = (id: number) => verdicts().get(id);
