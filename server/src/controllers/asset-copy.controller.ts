import { Body, Controller, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { AssetCopyOriginalDto } from 'src/dtos/asset-copy.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { ApiTag, Permission, RouteKey } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { LibraryService } from 'src/services/library.service';
import { UUIDParamDto } from 'src/validation';

// kept out of the OpenAPI spec: the web client calls it directly
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
