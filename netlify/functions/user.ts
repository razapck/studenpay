import serverless from 'serverless-http';
import { app } from '../../src/services/user/index';

export const handler = serverless(app);
