import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sessionRouter from "./session";
import routeRouter from "./route";
import requestsRouter from "./requests";
import driverRouter from "./driver";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sessionRouter);
router.use(routeRouter);
router.use(requestsRouter);
router.use(driverRouter);
router.use(adminRouter);

export default router;
