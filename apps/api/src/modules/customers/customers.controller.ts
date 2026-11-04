import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import {
  type ListCustomersQuery,
  listCustomersSchema,
  CustomersService,
} from './customers.service';

@ApiTags('Customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('order:read')
  @ApiOperation({ summary: 'Customers, paged, with completed-order statistics' })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listCustomersSchema)) query: ListCustomersQuery,
  ) {
    return this.customers.list(auth, query);
  }
}
