// @ts-ignore
import { worker } from '@electric-sql/pglite/worker';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

worker({
    async init(options: any) {
        return await PGlite.create({
            ...options,
            extensions: { vector }
        });
    }
});
