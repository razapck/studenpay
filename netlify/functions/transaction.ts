import serverless from 'serverless-http';
import { app } from '../../src/services/transaction/index';

export const handler = serverless(app);
