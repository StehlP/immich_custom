import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { AssetCopyDeleteDto, AssetCopyDeleteResult, AssetCopyOriginalDto } from 'src/dtos/asset-copy.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { ApiTag, Permission, RouteKey } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { LibraryService } from 'src/services/library.service';
import { UUIDParamDto } from 'src/validation';

// kept out of the OpenAPI spec: the web client calls these routes directly

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class AssetCopyController {
  constructor(private service: LibraryService) {}

  @Put(':id/copies/original')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  setAssetOriginalCopy(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetCopyOriginalDto,
  ): Promise<void> {
    return this.service.setExternalOriginal(auth, id, dto);
  }
}

// separate prefix: /assets/copies would be captured by the /assets/:id routes
@ApiTags(ApiTag.Assets)
@Controller('asset-copies')
export class AssetCopiesController {
  constructor(private service: LibraryService) {}

  @Get()
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.AssetRead })
  getExternalCopies(@Auth() auth: AuthDto) {
    return this.service.getExternalCopiesOverview(auth);
  }

  @Delete()
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.AssetDelete })
  deleteExternalCopies(@Auth() auth: AuthDto, @Body() dto: AssetCopyDeleteDto): Promise<AssetCopyDeleteResult> {
    return this.service.deleteExternalCopies(auth, dto);
  }
}
