# CloudFront in front of presigned S3 playback URLs (Phase 5 hardening
# item, docs/aws-deployment.md). api-gateway's playback routes
# (apps/api-gateway/src/routes/playback.ts) presign HLS playlist/segment
# GETs against `process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT`
# — that env var is the seam this distribution plugs into (wired below in
# ecs-gateway.tf / ecs-video.tf). Today, with the var unset, presigning
# happens directly against S3; this distribution puts a CDN edge and a
# custom domain in front of the exact same presigned-URL flow.
#
# Origin: a plain S3 REST endpoint, deliberately with NO Origin Access
# Control/Identity. An OAC/OAI makes CloudFront sign every origin request
# itself and strips or rejects the viewer's own query-string credentials,
# which would break every presigned URL api-gateway hands out (that's the
# classic "presigned URLs 403 behind CloudFront" trap). The bucket already
# blocks all public/anonymous access
# (aws_s3_bucket_public_access_block.media in storage.tf) — the only thing
# that can ever read from it is a valid presigned URL, whether that
# request arrives via CloudFront or (today) directly against S3. Routing
# that traffic through CloudFront doesn't change who can read the bucket,
# only where the read is cached/terminated.

# CloudFront's viewer certificate must be an ACM cert issued in us-east-1,
# regardless of which region the rest of the stack runs in (var.aws_region
# / providers.tf is ap-south-1, not us-east-1). Second aliased provider +
# its own cert, issued/validated the same way https.tf already does for
# the ALB's cert, against the same pre-existing Route53 zone.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

resource "aws_acm_certificate" "cloudfront" {
  provider = aws.us_east_1

  domain_name       = "media.${var.domain_name}"
  validation_method = "DNS"

  tags = {
    Name = "${local.name_prefix}-cloudfront-cert"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cloudfront_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for r in aws_route53_record.cloudfront_cert_validation : r.fqdn]
}

resource "aws_cloudfront_distribution" "media" {
  enabled     = true
  comment     = "${local.name_prefix}-media"
  price_class = "PriceClass_100" # US/Europe only — cost-conscious side-project infra, not global scale
  aliases     = ["media.${var.domain_name}"]

  origin {
    domain_name = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id   = "${local.name_prefix}-media-s3"

    # No s3_origin_config (that's what turns on Origin Access
    # Identity/Control) and no custom_origin_config override — see the
    # file header for why this origin is deliberately left as a plain
    # passthrough to S3's REST endpoint rather than an OAC-fronted origin.
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "${local.name_prefix}-media-s3"
    compress         = true

    viewer_protocol_policy = "redirect-to-https"

    # Presigned URLs carry their auth entirely in the query string
    # (AWSAccessKeyId/Signature/Expires, or the X-Amz-* SigV4 equivalents)
    # — these MUST reach the origin on every request or presigned auth
    # breaks (S3 will 403). So query strings are forwarded in full.
    #
    # Forwarding the full query string also makes it part of CloudFront's
    # cache key (the default behavior for forwarded_values with
    # query_string = true and no query_string_cache_keys allowlist). That
    # is the simplest *safe* default for this pass: since the signature
    # is part of the key, two different presigned URLs — even for the
    # same S3 object — can never collide in the cache, so CloudFront can
    # never serve one viewer's segment back under another viewer's
    # (differently-scoped or differently-expiring) presigned request.
    #
    # The tradeoff is cache efficiency: api-gateway mints a fresh
    # Signature/Expires on every presign, so most requests miss and go to
    # origin anyway — this config buys HTTPS termination, edge presence,
    # and a stable custom domain more than it buys a high hit ratio. A
    # real fix (e.g. an origin-request policy / CloudFront Function that
    # strips just the signature params from the cache key while still
    # forwarding them to origin) is a legitimate follow-up but is its own
    # careful piece of work — out of scope for this hardening pass.
    forwarded_values {
      query_string = true

      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 604800
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cloudfront.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name = "${local.name_prefix}-media"
  }
}

resource "aws_route53_record" "media_cdn" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "media.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.media.domain_name
    zone_id                = aws_cloudfront_distribution.media.hosted_zone_id
    evaluate_target_health = false
  }
}
