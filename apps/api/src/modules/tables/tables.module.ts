import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TablesController } from './tables.controller';

@Module({
  imports: [AuthModule],
  controllers: [TablesController],
})
export class TablesModule {}
