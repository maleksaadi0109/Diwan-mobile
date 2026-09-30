import { Router, type IRouter } from "express";
import healthRouter from "./health";
import youtubeRouter from "./youtube";
import mizanRouter from "./mizan";
import jobsRouter from "./jobs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(youtubeRouter);
router.use(mizanRouter);
router.use(jobsRouter);

export default router;
