import serverless from 'serverless-http';
import { app } from '../../src/services/wallet/index';

export const handler = serverless(app);
