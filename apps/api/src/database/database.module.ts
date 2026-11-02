import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseRoleCheck } from './database-role.check';
import { buildDataSourceOptions } from './typeorm.options';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        ...buildDataSourceOptions(config.snapshot(), 'app'),
        autoLoadEntities: true,
        retryAttempts: 5,
        retryDelay: 2_000,
      }),
    }),
  ],
  providers: [DatabaseRoleCheck],
})
export class DatabaseModule {}
