CREATE TABLE "BlogPost" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "imageAlt" TEXT NOT NULL,
    "author" TEXT NOT NULL DEFAULT 'Equipe Rook Money',
    "published" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlogPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BlogPost_slug_key" ON "BlogPost"("slug");
CREATE INDEX "BlogPost_published_createdAt_idx" ON "BlogPost"("published", "createdAt");
CREATE INDEX "BlogPost_category_idx" ON "BlogPost"("category");
CREATE INDEX "BlogPost_slug_idx" ON "BlogPost"("slug");
